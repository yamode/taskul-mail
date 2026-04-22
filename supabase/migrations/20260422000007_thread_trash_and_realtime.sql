-- ============================================================
-- UI UX 改善: スレッドのソフトデリート + Realtime 対応
--
-- 注意: supabase db push はローカル migrations と衝突するため、
--       Supabase Dashboard → SQL Editor で手動実行すること。
-- ============================================================

-- 1) スレッドのソフトデリート用カラム
alter table mail.threads
  add column if not exists trashed_at timestamptz;

create index if not exists threads_trashed_idx
  on mail.threads (account_id, trashed_at);

-- スレッドへの UPDATE ポリシ (ゴミ箱操作用)
drop policy if exists "threads update follows account access" on mail.threads;
create policy "threads update follows account access"
  on mail.threads for update
  using (mail.has_account_access(account_id))
  with check (mail.has_account_access(account_id));

-- 2) Realtime 対応: mail.messages / mail.threads を supabase_realtime publication に追加
-- 既に追加済みなら no-op (alter publication では IF NOT EXISTS が使えないので DO ブロックで判定)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'mail'
      and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table mail.messages';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'mail'
      and tablename = 'threads'
  ) then
    execute 'alter publication supabase_realtime add table mail.threads';
  end if;
end $$;
