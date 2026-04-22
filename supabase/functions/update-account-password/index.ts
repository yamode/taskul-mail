// supabase/functions/update-account-password/index.ts
// 既存アカウントのパスワードのみ Vault 上で更新する。
//
// 入力: { account_id: uuid, password: string }
// 出力: { ok: true }

import { adminClient, updateSecret } from "../_shared/vault.ts";
import { handlePreflight, jsonResponse, corsHeaders } from "../_shared/cors.ts";

async function authUserId(req: Request): Promise<string> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("missing auth token");
  const sb = adminClient();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) throw new Error("invalid auth");
  return data.user.id;
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders(req) });
  }

  try {
    const userId = await authUserId(req);
    const { account_id, password } = await req.json();
    if (!account_id || !password) throw new Error("account_id and password required");

    const sb = adminClient();

    // オーナー本人かチェック
    const { data: acc, error: aErr } = await sb
      .from("accounts")
      .select("id,owner_id,password_secret_id")
      .eq("id", account_id)
      .single();
    if (aErr || !acc) throw new Error("account not found");
    if (acc.owner_id !== userId) {
      return new Response("forbidden", { status: 403, headers: corsHeaders(req) });
    }

    await updateSecret(sb, acc.password_secret_id, password);

    return jsonResponse(req, { ok: true });
  } catch (e) {
    return jsonResponse(req, { error: (e as Error).message }, 400);
  }
});
