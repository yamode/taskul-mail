// supabase/functions/_shared/vault.ts
// Supabase Vault 経由で IMAP/SMTP パスワードを安全に扱う
//
// 前提: vault.secrets を読めるのは service_role のみ。
// Edge Functions からは service_role クライアントでアクセスする。

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

/** mail スキーマをデフォルトにした service_role クライアント */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: { persistSession: false },
      db: { schema: "mail" },
    },
  );
}

/** 新規シークレット作成。作成された secret_id を返す */
export async function createSecret(
  sb: SupabaseClient,
  name: string,
  secret: string,
): Promise<string> {
  const { data, error } = await sb.rpc("vault_create_secret", {
    p_secret: secret,
    p_name: name,
  });
  if (error) throw new Error(`vault create failed: ${error.message}`);
  return data as string;
}

/** secret_id から平文を取得 (service_role 必須) */
export async function readSecret(
  sb: SupabaseClient,
  secretId: string,
): Promise<string> {
  const { data, error } = await (sb as any)
    .schema("vault")
    .from("decrypted_secrets")
    .select("decrypted_secret")
    .eq("id", secretId)
    .single();
  if (error) throw new Error(`vault read failed: ${error.message}`);
  return (data as { decrypted_secret: string }).decrypted_secret;
}

/** シークレット更新 */
export async function updateSecret(
  sb: SupabaseClient,
  secretId: string,
  newSecret: string,
): Promise<void> {
  const { error } = await sb.rpc("vault_update_secret", {
    p_id: secretId,
    p_secret: newSecret,
  });
  if (error) throw new Error(`vault update failed: ${error.message}`);
}
