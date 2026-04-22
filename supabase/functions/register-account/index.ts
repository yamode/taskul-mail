// supabase/functions/register-account/index.ts
// フロントから受け取ったパスワードを Vault に保存し、mail_accounts に INSERT する。
// (フロントから直接 public.mail_accounts に insert させない理由:
//  password_secret_id に有効な Vault ID を入れる必要があるため)

import { adminClient, createSecret } from "../_shared/vault.ts";
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
    const body = await req.json();
    const {
      label,
      email_address,
      password,
      is_shared = false,
      imap_host = "imap.xserver.jp",
      imap_port = 993,
      smtp_host = "smtp.xserver.jp",
      smtp_port = 465,
      default_tone = "",
    } = body;

    if (!label || !email_address || !password) {
      throw new Error("label, email_address, password required");
    }

    const sb = adminClient();

    // Vault にパスワード保存
    const secretName = `mail:${userId}:${email_address}:${Date.now()}`;
    const secretId = await createSecret(sb, secretName, password);

    // アカウント作成
    // default_tone カラム未作成 (migration 20260422000008 未適用) でも
    // 登録自体は成功させたいので、失敗時は default_tone を外して再試行。
    const basePayload = {
      owner_id: userId,
      label,
      email_address,
      username: email_address,
      imap_host,
      imap_port,
      smtp_host,
      smtp_port,
      password_secret_id: secretId,
      is_shared,
    };
    let insertRes = await sb
      .from("accounts")
      .insert({ ...basePayload, default_tone })
      .select("id")
      .single();
    if (insertRes.error && /default_tone/.test(insertRes.error.message ?? "")) {
      insertRes = await sb
        .from("accounts")
        .insert(basePayload)
        .select("id")
        .single();
    }
    const { data, error } = insertRes;
    if (error) throw error;

    // 共有アカウントなら owner をメンバーにも登録
    if (is_shared) {
      await sb.from("account_members").insert({
        account_id: data!.id,
        user_id: userId,
        role: "owner",
      });
    }

    return jsonResponse(req, { id: data!.id });
  } catch (e) {
    return jsonResponse(req, { error: (e as Error).message }, 400);
  }
});
