-- ============================================================
-- Realtime 拡張: message_reads / drafts を購読可能にする
--
-- 目的:
--   - 共有アカウントで他メンバーの既読操作を即時反映
--   - 他端末で編集した下書きの件数をリアルタイム更新
--
-- 注意: Supabase Dashboard → SQL Editor で手動実行すること
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'mail'
      and tablename = 'message_reads'
  ) then
    execute 'alter publication supabase_realtime add table mail.message_reads';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'mail'
      and tablename = 'drafts'
  ) then
    execute 'alter publication supabase_realtime add table mail.drafts';
  end if;
end $$;
