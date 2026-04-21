-- ============================================================
-- tasukul-mail: 初期スキーマ
-- ============================================================

-- Vault 拡張 (Supabase 標準搭載、有効化のみ)
create extension if not exists supabase_vault with schema vault;
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- mail_accounts: IMAP/SMTP アカウント
-- ------------------------------------------------------------
create table public.mail_accounts (
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

create index on public.mail_accounts (owner_id);
create index on public.mail_accounts (is_shared);

-- ------------------------------------------------------------
-- mail_account_members: 共有アカウントのアクセス制御
-- ------------------------------------------------------------
create table public.mail_account_members (
  account_id uuid references public.mail_accounts(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member',                  -- 'owner' | 'member'
  added_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

-- ------------------------------------------------------------
-- mail_threads: スレッド
-- ------------------------------------------------------------
create table public.mail_threads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.mail_accounts(id) on delete cascade,
  subject_normalized text,                              -- Re:/Fwd: 除去済み
  participants text[] not null default '{}',
  last_message_at timestamptz not null,
  message_count int not null default 0,
  created_at timestamptz not null default now()
);

create index on public.mail_threads (account_id, last_message_at desc);

-- ------------------------------------------------------------
-- mail_messages: メッセージ本体
-- ------------------------------------------------------------
create table public.mail_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.mail_accounts(id) on delete cascade,
  thread_id uuid references public.mail_threads(id) on delete set null,
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

create index on public.mail_messages (account_id, received_at desc);
create index on public.mail_messages (thread_id, received_at);
create index on public.mail_messages (message_id);

-- ------------------------------------------------------------
-- mail_message_reads: 既読トラッキング (共有アカウント用)
-- 代表アドレスで「誰が読んだか」を個別記録
-- ------------------------------------------------------------
create table public.mail_message_reads (
  message_id uuid references public.mail_messages(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index on public.mail_message_reads (user_id);

-- ------------------------------------------------------------
-- mail_attachments
-- ------------------------------------------------------------
create table public.mail_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.mail_messages(id) on delete cascade,
  filename text not null,
  content_type text,
  size_bytes bigint,
  storage_path text,                                    -- Supabase Storage
  content_id text,                                      -- インライン画像用
  created_at timestamptz not null default now()
);

create index on public.mail_attachments (message_id);

-- ------------------------------------------------------------
-- mail_drafts: 下書き (AI 生成 or 手動)
-- ------------------------------------------------------------
create table public.mail_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.mail_accounts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  in_reply_to_message_id uuid references public.mail_messages(id) on delete set null,
  thread_id uuid references public.mail_threads(id) on delete set null,
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

create index on public.mail_drafts (account_id, status);
create index on public.mail_drafts (author_id);

-- ------------------------------------------------------------
-- updated_at トリガ
-- ------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger mail_accounts_updated before update on public.mail_accounts
  for each row execute function public.tg_set_updated_at();
create trigger mail_drafts_updated before update on public.mail_drafts
  for each row execute function public.tg_set_updated_at();

-- ============================================================
-- RLS
-- ============================================================

alter table public.mail_accounts enable row level security;
alter table public.mail_account_members enable row level security;
alter table public.mail_threads enable row level security;
alter table public.mail_messages enable row level security;
alter table public.mail_message_reads enable row level security;
alter table public.mail_attachments enable row level security;
alter table public.mail_drafts enable row level security;

-- アカウントへのアクセス判定ヘルパ
create or replace function public.has_account_access(p_account_id uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.mail_accounts a
    where a.id = p_account_id
      and (
        a.owner_id = auth.uid()
        or (a.is_shared and exists (
          select 1 from public.mail_account_members m
          where m.account_id = a.id and m.user_id = auth.uid()
        ))
      )
  );
$$;

-- mail_accounts ポリシ
create policy "own or shared accounts readable"
  on public.mail_accounts for select
  using (
    owner_id = auth.uid()
    or (is_shared and exists (
      select 1 from public.mail_account_members m
      where m.account_id = id and m.user_id = auth.uid()
    ))
  );

create policy "owner manages account"
  on public.mail_accounts for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- mail_account_members ポリシ
create policy "members visible to account participants"
  on public.mail_account_members for select
  using (public.has_account_access(account_id));

create policy "owner manages members"
  on public.mail_account_members for all
  using (
    exists (
      select 1 from public.mail_accounts a
      where a.id = account_id and a.owner_id = auth.uid()
    )
  );

-- mail_threads / mail_messages ポリシ (アカウントアクセス権に従う)
create policy "threads follow account access"
  on public.mail_threads for select
  using (public.has_account_access(account_id));

create policy "messages follow account access"
  on public.mail_messages for select
  using (public.has_account_access(account_id));

create policy "attachments follow message access"
  on public.mail_attachments for select
  using (
    exists (
      select 1 from public.mail_messages m
      where m.id = message_id and public.has_account_access(m.account_id)
    )
  );

-- mail_message_reads: 自分の既読記録のみ操作可 / 共有アカウントでは他人の記録も閲覧可
create policy "reads visible within shared account"
  on public.mail_message_reads for select
  using (
    exists (
      select 1 from public.mail_messages m
      where m.id = message_id and public.has_account_access(m.account_id)
    )
  );

create policy "user manages own reads"
  on public.mail_message_reads for insert
  with check (user_id = auth.uid());

create policy "user deletes own reads"
  on public.mail_message_reads for delete
  using (user_id = auth.uid());

-- mail_drafts ポリシ
create policy "drafts readable by author or shared account members"
  on public.mail_drafts for select
  using (
    author_id = auth.uid()
    or public.has_account_access(account_id)
  );

create policy "author manages own drafts"
  on public.mail_drafts for all
  using (author_id = auth.uid())
  with check (author_id = auth.uid() and public.has_account_access(account_id));
