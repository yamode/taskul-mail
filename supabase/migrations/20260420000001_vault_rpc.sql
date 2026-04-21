-- Vault ラッパー RPC
-- Edge Functions から SUPABASE_SERVICE_ROLE_KEY で呼ぶ想定
-- RLS は効かないが、実行権限を service_role のみに限定する

create or replace function public.vault_create_secret(
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
  select vault.create_secret(p_secret, p_name) into v_id;
  return v_id;
end;
$$;

create or replace function public.vault_update_secret(
  p_id uuid,
  p_secret text
) returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  perform vault.update_secret(p_id, p_secret);
end;
$$;

revoke execute on function public.vault_create_secret(text, text) from public, anon, authenticated;
revoke execute on function public.vault_update_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.vault_create_secret(text, text) to service_role;
grant execute on function public.vault_update_secret(uuid, text) to service_role;
