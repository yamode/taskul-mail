// supabase/functions/imap-mark-seen/index.ts
// taskul-mail 側で既読化したメッセージを IMAP サーバにも \Seen として反映する。
//
// 入力: { message_ids: string[] }
// 出力: { ok: true, results: { [account_email]: { marked: number[] } | { error, reason? } } }
//
// 方針:
//   - 共有アカウントは **対象外**。共有は per-user の既読 (message_reads) を保ち、
//     サーバ側 \Seen を立てると CONDSTORE 経由で全メンバーに既読伝播してしまうため。
//   - 個人アカウントでのみ UID STORE +FLAGS (\Seen) を実行。
//   - DB 側の message_reads はフロントが直接 upsert 済み。ここでは IMAP だけ触る。

import { adminClient, readSecret } from "../_shared/vault.ts";
import { handlePreflight, jsonResponse, corsHeaders } from "../_shared/cors.ts";
import { markSeenRawImap } from "../_shared/raw-imap.ts";

async function authUserId(req: Request): Promise<string> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("missing auth token");
  const sb = adminClient();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) throw new Error("invalid auth");
  return data.user.id;
}

type AccountRow = {
  id: string;
  email_address: string;
  imap_host: string;
  imap_port: number;
  username: string;
  password_secret_id: string;
  is_shared: boolean;
  owner_id: string | null;
};

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders(req) });
  }

  try {
    const userId = await authUserId(req);
    const body = await req.json().catch(() => ({}));
    const messageIds: string[] = Array.isArray(body?.message_ids) ? body.message_ids : [];
    if (messageIds.length === 0) {
      return jsonResponse(req, { error: "message_ids required" }, 400);
    }

    const sb = adminClient();

    const { data: msgs, error: mErr } = await sb
      .from("messages")
      .select("id,account_id,imap_uid")
      .in("id", messageIds)
      .not("imap_uid", "is", null);
    if (mErr) return jsonResponse(req, { error: mErr.message }, 500);
    if (!msgs || msgs.length === 0) {
      return jsonResponse(req, { ok: true, results: {} });
    }

    const accountIds = Array.from(new Set((msgs as { account_id: string }[]).map((m) => m.account_id)));

    const { data: accounts, error: aErr } = await sb
      .from("accounts")
      .select("id,email_address,imap_host,imap_port,username,password_secret_id,is_shared,owner_id")
      .in("id", accountIds);
    if (aErr) return jsonResponse(req, { error: aErr.message }, 500);

    // 個人アカウント = owner_id == userId かつ is_shared == false のみ
    const targetAccounts = (accounts as AccountRow[] ?? []).filter(
      (a) => !a.is_shared && a.owner_id === userId,
    );

    const uidsByAccount = new Map<string, number[]>();
    const allowedIds = new Set(targetAccounts.map((a) => a.id));
    for (const m of (msgs ?? []) as { account_id: string; imap_uid: number }[]) {
      if (!allowedIds.has(m.account_id)) continue;
      if (m.imap_uid == null) continue;
      const arr = uidsByAccount.get(m.account_id) ?? [];
      arr.push(Number(m.imap_uid));
      uidsByAccount.set(m.account_id, arr);
    }

    const results: Record<string, unknown> = {};

    await Promise.all(targetAccounts.map(async (acc) => {
      const uids = uidsByAccount.get(acc.id) ?? [];
      if (uids.length === 0) {
        results[acc.email_address] = { marked: [] };
        return;
      }
      try {
        const password = await readSecret(sb, acc.password_secret_id);
        const r = await markSeenRawImap({
          host: acc.imap_host,
          port: acc.imap_port,
          user: acc.username,
          pass: password,
          uids,
          mailbox: "INBOX",
        });
        results[acc.email_address] = { marked: r.marked };
      } catch (e) {
        console.error(`imap-mark-seen failed for ${acc.email_address}`, e);
        results[acc.email_address] = { error: (e as Error).message };
      }
    }));

    // 共有アカウントは対象外としてスキップした旨を返す (デバッグ用)
    const skipped = (accounts as AccountRow[] ?? [])
      .filter((a) => !targetAccounts.some((t) => t.id === a.id))
      .map((a) => a.email_address);
    if (skipped.length > 0) {
      results["_skipped_shared"] = skipped;
    }

    return jsonResponse(req, { ok: true, results });
  } catch (e) {
    return jsonResponse(req, { error: (e as Error).message }, 500);
  }
});
