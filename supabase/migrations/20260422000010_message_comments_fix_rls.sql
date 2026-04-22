-- ============================================================
-- 20260422000009 の修正
--
-- 問題:
--   INSERT ポリシの内側サブクエリで "m.id = message_id" と書いたが、
--   mail.messages には message_id text カラム (RFC822 Message-ID) があるため
--   unqualified の `message_id` が mail.messages.message_id (text) として
--   解決され、UUID との比較で "operator does not exist: uuid = text" になる。
--
-- Supabase Dashboard の SQL Editor は 1 ファイル 1 トランザクションで
-- 実行するため、9 番が失敗していた場合テーブル自体が存在しない可能性がある。
-- したがってこのファイルは「テーブル作成〜RLS まで」全てを冪等に適用する。
-- 既に 9 番が成功していた環境では既存リソースに対して drop/recreate で上書きする。
-- ============================================================

create table if not exists mail.message_comments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references mail.messages(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_email text,
  author_name text,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists message_comments_message_idx
  on mail.message_comments (message_id, created_at);
create index if not exists message_comments_author_idx
  on mail.message_comments (author_id);

drop trigger if exists message_comments_updated on mail.message_comments;
create trigger message_comments_updated before update on mail.message_comments
  for each row execute function mail.tg_set_updated_at();

alter table mail.message_comments enable row level security;

-- SELECT: アカウントにアクセスできるメンバー全員が閲覧可
drop policy if exists "comments visible within shared account" on mail.message_comments;
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
-- ★ 重要: mail.messages.message_id (RFC822 text) と名前衝突するため
--        外側の列は必ず mail.message_comments.message_id と修飾する
drop policy if exists "user inserts own comment on accessible message" on mail.message_comments;
create policy "user inserts own comment on accessible message"
  on mail.message_comments for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from mail.messages m
      where m.id = mail.message_comments.message_id
        and mail.has_account_access(m.account_id)
    )
  );

-- UPDATE: 自分の投稿のみ編集可
drop policy if exists "user edits own comment" on mail.message_comments;
create policy "user edits own comment"
  on mail.message_comments for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- DELETE: 自分の投稿のみ削除可
drop policy if exists "user deletes own comment" on mail.message_comments;
create policy "user deletes own comment"
  on mail.message_comments for delete
  using (author_id = auth.uid());

-- Realtime publication 追加
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
