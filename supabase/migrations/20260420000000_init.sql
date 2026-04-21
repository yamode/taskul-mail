-- ============================================================
-- tasukul-mail: 初期スキーマ
--
-- 方針:
--   - taskul と同一 Supabase プロジェクトに相乗りするため、
--     全テーブルを専用スキーマ `mail` に隔離する。
--   - Supabase Dashboard → Project Settings → API の
--     "Exposed schemas" に `mail` を追加すること (PostgREST から見える化)。
-- ============================================================

-- Vault 拡張 (Supabase 標準搭載、有効化のみ)
create extension if not exists supabase_vault with schema vault;
create extension if not exists pgcrypto;

create schema if not exists mail;
grant usage on schema mail to authenticated, service_role;

-- ------------------------------------------------------------
-- mail.accounts: IMAP/SMTP アカウント
-- ------------------------------------------------------------
create table mail.accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  label text not null,                                  -- "代表", "ひかる個人"
  email_address text not null,
  imap_host text not null default 'imap.xserver.jp',
  imap_port int not null default 993,
  smtp_host text not null default 'smtp.xserver.jp',
  smtp_port int not null default 465,
  username text not null,                               -- 通常は email_address と同じ
  password_secret_id uuid not null,                     -- vault.secrets への参照
  is_shared boolean not null default false,             -- 代表アドレスか
  last_synced_at timestamptz,
  last_uid bigint default 0,                            -- IMAP UID (差分同期用)
  last_uidvalidity bigint,                              -- UIDVALIDITY 変わったら全再取得
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on mail.accounts (owner_id);
create index on mail.accounts (is_shared);

-- ------------------------------------------------------------
-- mail.account_members: 共有アカウントのアクセス制御
-- ------------------------------------------------------------
create table mail.account_members (
  account_id uuid references mail.accounts(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member',                  -- 'owner' | 'member'
  added_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

-- ------------------------------------------------------------
-- mail.threads: スレッド
-- ------------------------------------------------------------
create table mail.threads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail.accounts(id) on delete cascade,
  subject_normalized text,                              -- Re:/Fwd: 除去済み
  participants text[] not null default '{}',
  last_message_at timestamptz not null,
  message_count int not null default 0,
  created_at timestamptz not null default now()
);

create index on mail.threads (account_id, last_message_at desc);

-- ------------------------------------------------------------
-- mail.messages: メッセージ本体
-- ------------------------------------------------------------
create table mail.messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail.accounts(id) on delete cascade,
  thread_id uuid references mail.threads(id) on delete set null,
  imap_uid bigint not null,
  message_id text,                                      -- RFC822 Message-ID
  in_reply_to text,
  message_references text[] default '{}',
  from_address text,
  from_name text,
  to_addresses text[] default '{}',
  cc_addresses text[] default '{}',
  bcc_addresses text[] default '{}',
  subject text,
  body_text text,
  body_html text,
  snippet text,                                         -- 一覧表示用 (先頭 200 字)
  received_at timestamptz not null,
  has_attachments boolean not null default false,
  direction text not null default 'inbound',            -- 'inbound' | 'outbound'
  raw_headers jsonb,
  created_at timestamptz not null default now(),
  unique (account_id, imap_uid)
);

create index on mail.messages (account_id, received_at desc);
create index on mail.messages (thread_id, received_at);
create index on mail.messages (message_id);

-- ------------------------------------------------------------
-- mail.message_reads: 既読トラッキング (共有アカウント用)
-- 代表アドレスで「誰が読んだか」を個別記録
-- ------------------------------------------------------------
create table mail.message_reads (
  message_id uuid references mail.messages(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index on mail.message_reads (user_id);

-- ------------------------------------------------------------
-- mail.attachments
-- ------------------------------------------------------------
create table mail.attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references mail.messages(id) on delete cascade,
  filename text not null,
  content_type text,
  size_bytes bigint,
  storage_path text,                                    -- Supabase Storage
  content_id text,                                      -- インライン画像用
  created_at timestamptz not null default now()
);

create index on mail.attachments (message_id);

-- ------------------------------------------------------------
-- mail.drafts: 下書き (AI 生成 or 手動)
-- ------------------------------------------------------------
create table mail.drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail.accounts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  in_reply_to_message_id uuid references mail.messages(id) on delete set null,
  thread_id uuid references mail.threads(id) on delete set null,
  to_addresses text[] not null default '{}',
  cc_addresses text[] default '{}',
  bcc_addresses text[] default '{}',
  subject text,
  body_text text,
  generated_by_ai boolean not null default false,
  ai_prompt_hint text,                                  -- 生成時のヒント
  status text not null default 'draft',                 -- 'draft' | 'sent' | 'discarded'
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on mail.drafts (account_id, status);
create index on mail.drafts (author_id);

-- ------------------------------------------------------------
-- updated_at トリガ
-- ------------------------------------------------------------
create or replace function mail.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger accounts_updated before update on mail.accounts
  for each row execute function mail.tg_set_updated_at();
create trigger drafts_updated before update on mail.drafts
  for each row execute function mail.tg_set_updated_at();

-- ============================================================
-- RLS
-- ============================================================

alter table mail.accounts enable row level security;
alter table mail.account_members enable row level security;
alter table mail.threads enable row level security;
alter table mail.messages enable row level security;
alter table mail.message_reads enable row level security;
alter table mail.attachments enable row level security;
alter table mail.drafts enable row level security;

-- アカウントへのアクセス判定ヘルパ
create or replace function mail.has_account_access(p_account_id uuid)
returns boolean language sql stable security definer
set search_path = mail, public as $$
  select exists (
    select 1 from mail.accounts a
    where a.id = p_account_id
      and (
        a.owner_id = auth.uid()
        or (a.is_shared and exists (
          select 1 from mail.account_members m
          where m.account_id = a.id and m.user_id = auth.uid()
        ))
      )
  );
$$;

-- 認証ユーザから has_account_access を呼べるようにする
grant execute on function mail.has_account_access(uuid) to authenticated, service_role;

-- mail.accounts ポリシ
create policy "own or shared accounts readable"
  on mail.accounts for select
  using (
    owner_id = auth.uid()
    or (is_shared and exists (
      select 1 from mail.account_members m
      where m.account_id = id and m.user_id = auth.uid()
    ))
  );

create policy "owner manages account"
  on mail.accounts for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- mail.account_members ポリシ
create policy "members visible to account participants"
  on mail.account_members for select
  using (mail.has_account_access(account_id));

create policy "owner manages members"
  on mail.account_members for all
  using (
    exists (
      select 1 from mail.accounts a
      where a.id = account_id and a.owner_id = auth.uid()
    )
  );

-- mail.threads / mail.messages ポリシ (アカウントアクセス権に従う)
create policy "threads follow account access"
  on mail.threads for select
  using (mail.has_account_access(account_id));

create policy "messages follow account access"
  on mail.messages for select
  using (mail.has_account_access(account_id));

create policy "attachments follow message access"
  on mail.attachments for select
  using (
    exists (
      select 1 from mail.messages m
      where m.id = mail.attachments.message_id
        and mail.has_account_access(m.account_id)
    )
  );

-- mail.message_reads: 自分の既読記録のみ操作可 / 共有アカウントでは他人の記録も閲覧可
create policy "reads visible within shared account"
  on mail.message_reads for select
  using (
    exists (
      select 1 from mail.messages m
      where m.id = mail.message_reads.message_id
        and mail.has_account_access(m.account_id)
    )
  );

create policy "user manages own reads"
  on mail.message_reads for insert
  with check (user_id = auth.uid());

create policy "user deletes own reads"
  on mail.message_reads for delete
  using (user_id = auth.uid());

-- mail.drafts ポリシ
create policy "drafts readable by author or shared account members"
  on mail.drafts for select
  using (
    author_id = auth.uid()
    or mail.has_account_access(account_id)
  );

create policy "author manages own drafts"
  on mail.drafts for all
  using (author_id = auth.uid())
  with check (author_id = auth.uid() and mail.has_account_access(account_id));
