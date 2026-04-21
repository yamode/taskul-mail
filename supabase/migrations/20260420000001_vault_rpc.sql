-- Vault ラッパー RPC (mail スキーマ)
-- Edge Functions から SUPABASE_SERVICE_ROLE_KEY で呼ぶ想定。
-- RLS は効かないが、実行権限を service_role のみに限定する。
--
-- 実装メモ:
--   vault.create_secret のシグネチャは Supabase のバージョンで揺れがある。
--   名前付きパラメータ (new_secret / new_name) で呼ぶのが一番安定。

create or replace function mail.vault_create_secret(
  p_secret text,
  p_name text
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
begin
  select vault.create_secret(
    new_secret => p_secret,
    new_name => p_name
  ) into v_id;
  return v_id;
end;
$$;

create or replace function mail.vault_update_secret(
  p_id uuid,
  p_secret text
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  perform vault.update_secret(
    secret_id => p_id,
    new_secret => p_secret
  );
end;
$$;

revoke execute on function mail.vault_create_secret(text, text) from public, anon, authenticated;
revoke execute on function mail.vault_update_secret(uuid, text) from public, anon, authenticated;
grant execute on function mail.vault_create_secret(text, text) to service_role;
grant execute on function mail.vault_update_secret(uuid, text) to service_role;
