-- vault.create_secret / vault.update_secret のシグネチャは Supabase バージョンで揺れがある:
--   新: vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '')
--   旧: vault.create_secret(p_plain_text text, p_id uuid DEFAULT gen_random_uuid(), p_description text DEFAULT '')
-- どちらでも動くよう、まず新シグネチャで試し、失敗したら旧シグネチャで試す。

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
  -- 新シグネチャ (new_secret, new_name)
  begin
    select vault.create_secret(
      new_secret => p_secret,
      new_name => p_name
    ) into v_id;
    return v_id;
  exception when others then
    -- 旧シグネチャ含めフォールバック
    null;
  end;

  -- フォールバック1: 引数1つだけ (どのバージョンでも secret は最初の引数)
  begin
    select vault.create_secret(p_secret) into v_id;
    return v_id;
  exception when others then
    null;
  end;

  raise exception 'vault.create_secret: no compatible signature found';
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
  begin
    perform vault.update_secret(secret_id => p_id, new_secret => p_secret);
    return;
  exception when others then
    null;
  end;

  begin
    perform vault.update_secret(p_id, p_secret);
    return;
  exception when others then
    null;
  end;

  raise exception 'vault.update_secret: no compatible signature found';
end;
$$;

revoke execute on function mail.vault_create_secret(text, text) from public, anon, authenticated;
revoke execute on function mail.vault_update_secret(uuid, text) from public, anon, authenticated;
grant execute on function mail.vault_create_secret(text, text) to service_role;
grant execute on function mail.vault_update_secret(uuid, text) to service_role;
