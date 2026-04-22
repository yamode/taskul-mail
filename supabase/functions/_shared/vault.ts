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
    p_secret: sanitizeSecret(secret),
    p_name: name,
  });
  if (error) throw new Error(`vault create failed: ${error.message}`);
  return data as string;
}

/** secret_id から平文を取得 (service_role 必須)
 *  vault スキーマは PostgREST に露出していないため、mail.vault_read_secret RPC 経由で取る。 */
export async function readSecret(
  sb: SupabaseClient,
  secretId: string,
): Promise<string> {
  const { data, error } = await sb.rpc("vault_read_secret", { p_id: secretId });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  if (!data) throw new Error(`vault read failed: secret not found`);
  return sanitizeSecret(data as string);
}

/** 制御文字・前後空白を除去。IMAP LOGIN が "Error in IMAP command" で落ちるのを防ぐ */
export function sanitizeSecret(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/** シークレット更新 */
export async function updateSecret(
  sb: SupabaseClient,
  secretId: string,
  newSecret: string,
): Promise<void> {
  const { error } = await sb.rpc("vault_update_secret", {
    p_id: secretId,
    p_secret: sanitizeSecret(newSecret),
  });
  if (error) throw new Error(`vault update failed: ${error.message}`);
}
