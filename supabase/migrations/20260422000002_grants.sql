-- mail スキーマに対する各ロールへの権限付与
-- 新規スキーマには Supabase デフォルトの権限が自動で付かないため明示する。
--   - service_role: 全権 (Edge Functions 用、RLS をバイパス)
--   - authenticated: select/insert/update/delete (RLS で個別制御)
--   - anon: なし (公開アクセス禁止)

-- 既存テーブル
grant all on all tables in schema mail to service_role;
grant all on all sequences in schema mail to service_role;
grant all on all routines in schema mail to service_role;

grant select, insert, update, delete on all tables in schema mail to authenticated;
grant usage on all sequences in schema mail to authenticated;

-- 今後追加するテーブル/シーケンスにも自動で同じ権限を付ける
alter default privileges in schema mail
  grant all on tables to service_role;
alter default privileges in schema mail
  grant all on sequences to service_role;
alter default privileges in schema mail
  grant all on routines to service_role;

alter default privileges in schema mail
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema mail
  grant usage on sequences to authenticated;
