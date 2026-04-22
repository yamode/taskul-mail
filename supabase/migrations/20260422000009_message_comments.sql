-- ============================================================
-- mail.message_comments: メッセージに対する社内コメント (内部メモ)
--
-- 共有代表アドレスで「誰が対応予定か」「なぜ残しているか」を
-- メンバー同士で共有するための内部メモ。
-- メール送受信には関与しない (IMAP/SMTP には流さない)。
--
-- 参考: mail.message_reads と同じ共有方針 (has_account_access)
-- 注意: supabase db push はローカル migrations と衝突するため、
--       Supabase Dashboard → SQL Editor で手動実行すること。
-- ============================================================

create table if not exists mail.message_comments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references mail.messages(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_email text,                                    -- 投稿時点のスナップショット (UI 表示用)
  author_name text,                                     -- user_metadata.full_name / name 等
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists message_comments_message_idx
  on mail.message_comments (message_id, created_at);
create index if not exists message_comments_author_idx
  on mail.message_comments (author_id);

create trigger message_comments_updated before update on mail.message_comments
  for each row execute function mail.tg_set_updated_at();

-- RLS
alter table mail.message_comments enable row level security;

-- SELECT: アカウントにアクセスできるメンバー全員が閲覧可 (message_reads と同方針)
create policy "comments visible within shared account"
  on mail.message_comments for select
  using (
    exists (
      select 1 from mail.messages m
      where m.id = mail.message_comments.message_id
        and mail.has_account_access(m.account_id)
    )
  );

-- INSERT: 自分名義 かつ アカウントにアクセス可能なメッセージへのみ投稿可
create policy "user inserts own comment on accessible message"
  on mail.message_comments for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from mail.messages m
      where m.id = message_id
        and mail.has_account_access(m.account_id)
    )
  );

-- UPDATE: 自分の投稿のみ編集可
create policy "user edits own comment"
  on mail.message_comments for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- DELETE: 自分の投稿のみ削除可
create policy "user deletes own comment"
  on mail.message_comments for delete
  using (author_id = auth.uid());

-- Realtime publication 追加 (複数メンバーがリアルタイムで同じメモ欄を見られるように)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'mail'
      and tablename = 'message_comments'
  ) then
    execute 'alter publication supabase_realtime add table mail.message_comments';
  end if;
end $$;
