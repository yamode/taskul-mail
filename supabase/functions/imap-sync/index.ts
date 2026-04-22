// supabase/functions/imap-sync/index.ts
// 全アカウントの IMAP 受信メールを差分同期する。
// Cron (5 分毎) から呼ばれる想定。
//
// 差分同期戦略:
//   - UIDVALIDITY が変わっていたら last_uid = 0 にリセット
//   - そうでなければ last_uid + 1 以降の UID を取得
//   - message-id + in-reply-to/references で既存スレッドに合流

import { ImapFlow } from "npm:imapflow@1.0.164";
import { simpleParser } from "npm:mailparser@3.6.9";
import { adminClient, readSecret } from "../_shared/vault.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";

type AccountRow = {
  id: string;
  email_address: string;
  imap_host: string;
  imap_port: number;
  username: string;
  password_secret_id: string;
  last_uid: number;
  last_uidvalidity: number | null;
};

/** 生TLS で AUTHENTICATE PLAIN を試すプレチェック。imapflow を使わず直接プロトコルを話す。
 *  LOGIN コマンドで拒否されるが PLAIN SASL なら通るケース (パスワードに `}` を含む等) の切り分け用。 */
async function rawAuthPlainProbe(
  host: string,
  port: number,
  user: string,
  pass: string,
  log: string[],
): Promise<"ok" | string> {
  const conn = await Deno.connectTls({ hostname: host, port });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = new Uint8Array(16384);

  const readChunk = async (): Promise<string> => {
    const n = await conn.read(buf);
    if (!n) return "";
    return dec.decode(buf.subarray(0, n));
  };

  const write = async (s: string) => {
    log.push(`PROBE>> ${s.replace(/\r\n/g, "\\r\\n")}`);
    await conn.write(enc.encode(s));
  };

  try {
    const greeting = await readChunk();
    log.push(`PROBE<< ${greeting.trim()}`);

    const payload = `\0${user}\0${pass}`;
    const b64 = btoa(payload);
    await write(`a1 AUTHENTICATE PLAIN ${b64}\r\n`);
    const resp = await readChunk();
    log.push(`PROBE<< ${resp.trim()}`);

    await write(`a2 LOGOUT\r\n`);
    try { await readChunk(); } catch { /* ignore */ }

    if (/^a1 OK/m.test(resp)) return "ok";
    return resp.trim();
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}

function normalizeSubject(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/gi, "").trim();
}

function snippetOf(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function syncOneAccount(account: AccountRow): Promise<Record<string, unknown>> {
  const sb = adminClient();
  const password = await readSecret(sb, account.password_secret_id);

  const diag: Record<string, unknown> = {
    account_last_uid: account.last_uid,
    account_last_uid_type: typeof account.last_uid,
    account_last_uidvalidity: account.last_uidvalidity,
    account_last_uidvalidity_type: typeof account.last_uidvalidity,
    imap_logs: [] as string[],
  };
  const imapLogs = diag.imap_logs as string[];

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.username, pass: password },
    logger: {
      debug: (o: unknown) => imapLogs.push(`DEBUG ${JSON.stringify(o)}`),
      info: (o: unknown) => imapLogs.push(`INFO  ${JSON.stringify(o)}`),
      warn: (o: unknown) => imapLogs.push(`WARN  ${JSON.stringify(o)}`),
      error: (o: unknown) => imapLogs.push(`ERROR ${JSON.stringify(o)}`),
    },
  });

  try {
    await client.connect();
  } catch (e) {
    (e as { diag?: unknown }).diag = diag;
    throw e;
  }
  const lock = await client.getMailboxLock("INBOX");

  try {
    const mailbox = client.mailbox;
    if (typeof mailbox === "boolean") throw new Error("mailbox not open");

    // bigint で返ってくる可能性があるので Number に正規化
    const serverUidValidity = Number(mailbox.uidValidity);
    const storedLastUid = Number(account.last_uid ?? 0);
    const storedUidValidity = account.last_uidvalidity === null || account.last_uidvalidity === undefined
      ? null
      : Number(account.last_uidvalidity);

    diag.server_uidvalidity = serverUidValidity;
    diag.stored_last_uid = storedLastUid;
    diag.stored_uidvalidity = storedUidValidity;

    // UIDVALIDITY 変化検知
    let fromUid = storedLastUid + 1;
    let effectiveLastUid = storedLastUid;
    if (storedUidValidity !== null && serverUidValidity !== storedUidValidity) {
      console.warn(`UIDVALIDITY changed for ${account.email_address}, resetting`);
      fromUid = 1;
      effectiveLastUid = 0;
    }

    const exists = Number((mailbox as { exists?: number }).exists ?? 0);
    diag.exists = exists;
    diag.from_uid = fromUid;

    // 末尾メッセージの UID を sequence 指定で確認。
    // stored_last_uid が実際の最大 UID を超えているケース (バグ・手動リセット後等) を自動検知するため。
    let actualMaxUid = 0;
    if (exists > 0) {
      for await (const m of client.fetch(`${exists}:${exists}`, { uid: true })) {
        actualMaxUid = Number(m.uid);
      }
    }
    diag.actual_max_uid = actualMaxUid;
    if (fromUid > actualMaxUid) {
      console.warn(`[${account.email_address}] fromUid(${fromUid}) > actualMaxUid(${actualMaxUid}), resetting to first sync`);
      fromUid = 1;
      effectiveLastUid = 0;
    }

    // 1 回あたりの処理上限。Edge Function の wall clock を考慮して抑えめに。
    const MAX_PER_RUN = 30;
    let processed = 0;
    let maxSeenUid = effectiveLastUid;
    const touchedThreads = new Map<string, string>();

    // 初回同期 (last_uid=0): sequence 末尾から MAX_PER_RUN 件。UID が飛び飛びでも確実に取れる。
    // 差分同期 (last_uid>0): UID で `fromUid:*` を指定し、実在メッセージだけ取る。
    const isFirstSync = effectiveLastUid === 0;
    const fetchRange = isFirstSync
      ? (exists > 0 ? `${Math.max(1, exists - MAX_PER_RUN + 1)}:${exists}` : null)
      : `${fromUid}:*`;
    diag.fetch_range = fetchRange;
    diag.is_first_sync = isFirstSync;

    const fetchIter = fetchRange
      ? client.fetch(
          fetchRange,
          { uid: true, envelope: true, source: true, internalDate: true },
          { uid: !isFirstSync },
        )
      : (async function* () {})();
    const shouldFetch = fetchRange !== null;

    console.log(`[${account.email_address}] fetchRange=${fetchRange} isFirstSync=${isFirstSync} exists=${exists}`);
    for await (const msg of fetchIter) {
      if (processed >= MAX_PER_RUN) break;
      processed++;
      console.log(`[${account.email_address}] got msg uid=${msg.uid} bytes=${msg.source?.length ?? 0}`);
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);
      console.log(`[${account.email_address}] parsed uid=${msg.uid}`);

      const messageId = parsed.messageId ?? null;
      const inReplyTo = parsed.inReplyTo ?? null;
      const references = Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
          ? [parsed.references]
          : [];

      const fromObj = parsed.from?.value?.[0];
      const toAddrs = parsed.to
        ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
            .flatMap((x) => x.value.map((v) => v.address).filter(Boolean))
        : [];
      const ccAddrs = parsed.cc
        ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
            .flatMap((x) => x.value.map((v) => v.address).filter(Boolean))
        : [];

      // スレッド解決
      const subjectNorm = normalizeSubject(parsed.subject);
      let threadId: string | null = null;

      const refKeys = [inReplyTo, ...references].filter(Boolean) as string[];
      if (refKeys.length > 0) {
        const { data: existing } = await sb
          .from("messages")
          .select("thread_id")
          .eq("account_id", account.id)
          .in("message_id", refKeys)
          .not("thread_id", "is", null)
          .limit(1)
          .maybeSingle();
        if (existing?.thread_id) threadId = existing.thread_id;
      }

      if (!threadId) {
        // 同件名で直近 14 日以内のスレッドに合流、なければ新規
        const { data: recent } = await sb
          .from("threads")
          .select("id")
          .eq("account_id", account.id)
          .eq("subject_normalized", subjectNorm)
          .gte(
            "last_message_at",
            new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(),
          )
          .order("last_message_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (recent?.id) {
          threadId = recent.id;
        } else {
          const { data: created, error: tErr } = await sb
            .from("threads")
            .insert({
              account_id: account.id,
              subject_normalized: subjectNorm,
              participants: [
                fromObj?.address,
                ...toAddrs,
                ...ccAddrs,
              ].filter(Boolean),
              last_message_at: (parsed.date ?? new Date()).toISOString(),
              message_count: 0,
            })
            .select("id")
            .single();
          if (tErr) throw tErr;
          threadId = created!.id;
        }
      }

      // メッセージ insert (重複は account_id+imap_uid の unique で弾く)
      const { error: mErr } = await sb.from("messages").upsert(
        {
          account_id: account.id,
          thread_id: threadId,
          imap_uid: Number(msg.uid),
          message_id: messageId,
          in_reply_to: inReplyTo,
          message_references: references,
          from_address: fromObj?.address ?? null,
          from_name: fromObj?.name ?? null,
          to_addresses: toAddrs,
          cc_addresses: ccAddrs,
          subject: parsed.subject ?? null,
          body_text: parsed.text ?? null,
          body_html: parsed.html || null,
          snippet: snippetOf(parsed.text),
          received_at: (parsed.date ?? new Date()).toISOString(),
          has_attachments: (parsed.attachments?.length ?? 0) > 0,
          direction: "inbound",
          raw_headers: {},
        },
        { onConflict: "account_id,imap_uid" },
      );
      if (mErr) {
        console.error("message insert failed", mErr);
        continue;
      }

      // last_message_at のみ更新 (件数集計は最後にまとめて)
      touchedThreads.set(threadId!, (parsed.date ?? new Date()).toISOString());

      if (Number(msg.uid) > maxSeenUid) maxSeenUid = Number(msg.uid);
    }

    // 触ったスレッドの message_count と last_message_at をまとめて更新
    for (const [tid, lastAt] of touchedThreads) {
      const { count } = await sb
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("thread_id", tid);
      await sb
        .from("threads")
        .update({ last_message_at: lastAt, message_count: count ?? 0 })
        .eq("id", tid);
    }

    // アカウントの同期ステート更新
    await sb
      .from("accounts")
      .update({
        last_uid: maxSeenUid,
        last_uidvalidity: Number(mailbox.uidValidity),
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    diag.processed = processed;
    diag.hit_limit = processed >= MAX_PER_RUN;
    diag.max_seen_uid = maxSeenUid;
  } finally {
    lock.release();
    await client.logout();
  }
  return diag;
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  // 単発アカウント指定 or 全件
  const url = new URL(req.url);
  const accountId = url.searchParams.get("account_id");

  const sb = adminClient();
  const q = sb
    .from("accounts")
    .select(
      "id,email_address,imap_host,imap_port,username,password_secret_id,last_uid,last_uidvalidity",
    );
  const { data: accounts, error } = accountId
    ? await q.eq("id", accountId)
    : await q;

  if (error) {
    return jsonResponse(req, { error: error.message }, 500);
  }

  // アカウントを並列で同期。認証失敗しているアカウントが他の処理を待たせないように。
  const results: Record<string, unknown> = {};
  await Promise.all(
    ((accounts ?? []) as AccountRow[]).map(async (acc) => {
      try {
        const diag = await syncOneAccount(acc);
        results[acc.email_address] = { status: "ok", diag };
      } catch (e) {
        const err = e as Error & {
          response?: string;
          responseText?: string;
          authenticationFailed?: boolean;
          code?: string;
          diag?: unknown;
        };
        console.error(`sync failed for ${acc.email_address}`, err);
        const detail = err.authenticationFailed
          ? "認証失敗 (パスワード or ユーザー名が違う or Xserver でメールパスワード未設定)"
          : err.responseText || err.response || err.message;
        results[acc.email_address] = {
          status: "error",
          detail,
          response: err.response,
          responseText: err.responseText,
          diag: err.diag,
        };
      }
    }),
  );

  return jsonResponse(req, { results });
});
