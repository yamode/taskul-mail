-- vault.decrypted_secrets を直接 PostgREST で叩くには vault スキーマを公開する必要があり、
-- セキュリティ上それは避けたい。SECURITY DEFINER の wrapper RPC を mail スキーマに置く。

create or replace function mail.vault_read_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = p_id;
  return v_secret;
end;
$$;

revoke execute on function mail.vault_read_secret(uuid) from public, anon, authenticated;
grant execute on function mail.vault_read_secret(uuid) to service_role;
