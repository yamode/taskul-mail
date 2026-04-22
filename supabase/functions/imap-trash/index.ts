// supabase/functions/imap-trash/index.ts
// スレッド (または個別メッセージ) を IMAP サーバ側の Trash フォルダへ MOVE する。
//
// これを呼ばずに DB の trashed_at だけ更新すると、他のメーラ/Webmail からは
// メールが残って見えてしまう。ユーザ体験的に「削除した」意図を満たすため、
// サーバ側フォルダ操作と DB 更新を 1 トランザクションに近い形で実行する。
//
// 入力: { thread_ids: string[] }   (少なくとも 1 件必須)
// 出力: { ok: true, results: { [account_email]: { moved: number[], method, trash } | { error } } }
//
// 権限: mail.has_account_access() と同等のチェックを手動で行う (owner か共有メンバー)。

import { adminClient, readSecret } from "../_shared/vault.ts";
import { handlePreflight, jsonResponse, corsHeaders } from "../_shared/cors.ts";
import { moveToTrashRawImap } from "../_shared/raw-imap.ts";

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
    const threadIds: string[] = Array.isArray(body?.thread_ids) ? body.thread_ids : [];
    if (threadIds.length === 0) {
      return jsonResponse(req, { error: "thread_ids required" }, 400);
    }

    const sb = adminClient();

    // スレッドごとの account_id を取得 (同時にアクセス権チェックの材料にする)
    const { data: threads, error: tErr } = await sb
      .from("threads")
      .select("id,account_id")
      .in("id", threadIds);
    if (tErr) return jsonResponse(req, { error: tErr.message }, 500);
    if (!threads || threads.length === 0) {
      return jsonResponse(req, { error: "no threads found" }, 404);
    }

    const accountIds = Array.from(new Set((threads as { account_id: string }[]).map((t) => t.account_id)));

    // アクセス権確認 + 接続情報取得
    const { data: accounts, error: aErr } = await sb
      .from("accounts")
      .select("id,email_address,imap_host,imap_port,username,password_secret_id,is_shared,owner_id")
      .in("id", accountIds);
    if (aErr) return jsonResponse(req, { error: aErr.message }, 500);

    // 共有アカウントは members にいるか、個人アカウントは owner_id == userId を確認
    const { data: memberships } = await sb
      .from("account_members")
      .select("account_id")
      .eq("user_id", userId)
      .in("account_id", accountIds);
    const memberSet = new Set((memberships ?? []).map((m: { account_id: string }) => m.account_id));

    const allowedAccounts = (accounts as AccountRow[] ?? []).filter((a) =>
      a.is_shared ? memberSet.has(a.id) : a.owner_id === userId,
    );
    if (allowedAccounts.length === 0) {
      return jsonResponse(req, { error: "forbidden" }, 403);
    }
    const allowedIds = new Set(allowedAccounts.map((a) => a.id));
    const allowedThreadIds = (threads as { id: string; account_id: string }[])
      .filter((t) => allowedIds.has(t.account_id))
      .map((t) => t.id);

    // スレッドに紐付く INBOX 取得済みメッセージの UID を集める
    const { data: msgs, error: mErr } = await sb
      .from("messages")
      .select("id,account_id,thread_id,imap_uid")
      .in("thread_id", allowedThreadIds)
      .not("imap_uid", "is", null);
    if (mErr) return jsonResponse(req, { error: mErr.message }, 500);

    const uidsByAccount = new Map<string, number[]>();
    for (const m of (msgs ?? []) as { account_id: string; imap_uid: number }[]) {
      if (m.imap_uid == null) continue;
      const arr = uidsByAccount.get(m.account_id) ?? [];
      arr.push(Number(m.imap_uid));
      uidsByAccount.set(m.account_id, arr);
    }

    const results: Record<string, unknown> = {};

    // アカウント並列で IMAP MOVE 実行
    await Promise.all(allowedAccounts.map(async (acc) => {
      const uids = uidsByAccount.get(acc.id) ?? [];
      if (uids.length === 0) {
        results[acc.email_address] = { moved: [], method: "noop", trash: null };
        return;
      }
      try {
        const password = await readSecret(sb, acc.password_secret_id);
        const r = await moveToTrashRawImap({
          host: acc.imap_host,
          port: acc.imap_port,
          user: acc.username,
          pass: password,
          uids,
          mailbox: "INBOX",
        });
        results[acc.email_address] = { moved: r.moved, method: r.method, trash: r.trashMailbox };
      } catch (e) {
        console.error(`imap-trash failed for ${acc.email_address}`, e);
        results[acc.email_address] = { error: (e as Error).message };
      }
    }));

    // DB 側の trashed_at はフロントの softDeleteThread ですでに更新済み。
    // ここでは IMAP MOVE の結果だけを返す。
    return jsonResponse(req, { ok: true, results });
  } catch (e) {
    return jsonResponse(req, { error: (e as Error).message }, 500);
  }
});
