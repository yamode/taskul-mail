-- ============================================================
-- Sent / Archive フォルダ対応 (Step 3a: スキーマ基盤)
--
-- 目的:
--   - INBOX 以外のフォルダ (Sent, Archive, Trash, ラベル等) を同期可能にする
--   - フォルダごとに UIDVALIDITY + last_uid を独立管理
--
-- この migration はスキーマ追加のみ。imap-sync 本体と UI の対応は
-- 後続タスク (Step 3b / 3c) で実装する。既存データは全て 'inbox' role の
-- 仮想フォルダに紐付く扱いのため、この migration 単体でのダウン時間は無い。
--
-- 注意: Supabase Dashboard → SQL Editor で手動実行すること
-- ============================================================

-- ------------------------------------------------------------
-- mail.folders: IMAP フォルダ (INBOX, Sent, Archive, Trash, ラベル)
-- ------------------------------------------------------------
create table if not exists mail.folders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references mail.accounts(id) on delete cascade,
  -- IMAP サーバ上のフォルダ名 ("INBOX", "Sent", "INBOX.Sent" 等、UTF7 decoded 済み)
  name text not null,
  -- 役割: SPECIAL-USE 属性または名前推定から判定
  --   inbox / sent / drafts / archive / trash / junk / other
  role text not null default 'other',
  -- SPECIAL-USE raw 文字列 ("\\Sent" など) — 取得できた場合のみ
  special_use text,
  -- 同期状態 (フォルダ単位)
  uidvalidity bigint,
  last_uid bigint not null default 0,
  last_synced_at timestamptz,
  -- UI 表示用
  sort_order int not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, name)
);

create index if not exists folders_account_idx on mail.folders (account_id, sort_order);
create index if not exists folders_role_idx on mail.folders (account_id, role);

-- 既存アカウントごとに INBOX フォルダを seed
-- (既存メッセージは全て INBOX から取得されたもの)
insert into mail.folders (account_id, name, role, uidvalidity, last_uid, last_synced_at)
select
  a.id,
  'INBOX',
  'inbox',
  a.last_uidvalidity,
  coalesce(a.last_uid, 0),
  a.last_synced_at
from mail.accounts a
on conflict (account_id, name) do nothing;

-- ------------------------------------------------------------
-- mail.messages.folder_id: メッセージがどのフォルダから取得されたか
-- ------------------------------------------------------------
alter table mail.messages
  add column if not exists folder_id uuid references mail.folders(id) on delete set null;

create index if not exists messages_folder_idx on mail.messages (folder_id, received_at desc);

-- 既存メッセージは全て INBOX フォルダに紐付け
update mail.messages m
set folder_id = f.id
from mail.folders f
where f.account_id = m.account_id
  and f.role = 'inbox'
  and m.folder_id is null;

-- ------------------------------------------------------------
-- messages の unique 制約を (account_id, folder_id, imap_uid) に変更
-- IMAP UID はフォルダごとの名前空間なので、フォルダをまたぐと衝突し得る
-- ------------------------------------------------------------
-- 既存の unique (account_id, imap_uid) を外して folder_id 含みで張り直す
do $$
declare
  c_name text;
begin
  select conname into c_name
  from pg_constraint
  where conrelid = 'mail.messages'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) like '%account_id, imap_uid%'
    and pg_get_constraintdef(oid) not like '%folder_id%';
  if c_name is not null then
    execute format('alter table mail.messages drop constraint %I', c_name);
  end if;
end $$;

-- folder_id が NULL の行が存在する可能性があるため、複合 unique index を使う
-- (constraint ではなく index — NULL を許容しつつ重複を防ぐ)
create unique index if not exists messages_account_folder_uid_uniq
  on mail.messages (account_id, folder_id, imap_uid)
  where folder_id is not null;

-- ------------------------------------------------------------
-- RLS: folders は account へのアクセス権を引き継ぐ
-- ------------------------------------------------------------
alter table mail.folders enable row level security;

create policy "folders readable by account members"
  on mail.folders for select
  using (mail.has_account_access(account_id));

create policy "folders writable by account members"
  on mail.folders for all
  using (mail.has_account_access(account_id))
  with check (mail.has_account_access(account_id));

-- updated_at 自動更新
create or replace function mail.touch_folder_updated()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger folders_updated before update on mail.folders
  for each row execute procedure mail.touch_folder_updated();

-- Realtime: folders の変更をリアルタイム購読可能にする
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'mail'
      and tablename = 'folders'
  ) then
    execute 'alter publication supabase_realtime add table mail.folders';
  end if;
end $$;
