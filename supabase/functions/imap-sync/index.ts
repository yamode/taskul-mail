// supabase/functions/imap-sync/index.ts
// 全アカウントの IMAP 受信メールを差分同期する。
// Cron (5 分毎) から呼ばれる想定。
//
// 差分同期戦略:
//   - UIDVALIDITY が変わっていたら last_uid = 0 にリセット
//   - そうでなければ last_uid + 1 以降の UID を取得
//   - message-id + in-reply-to/references で既存スレッドに合流

import { ImapFlow } from "npm:imapflow@1.3.2";
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

    // 末尾メッセージの UID を SEARCH で確認 (以前は for-await の probe fetch を使っていたが、
    // それが後続の fetchOne を hang させるため SEARCH に置換)。
    // 全 UID リストを後続の first モードで再利用するため保持。
    let actualMaxUid = 0;
    let allUidsCached: number[] = [];
    if (exists > 0) {
      const allUids = await client.search({ all: true }, { uid: true });
      allUidsCached = (allUids ?? []).map((u: unknown) => Number(u)).filter((n) => !isNaN(n));
      if (allUidsCached.length > 0) actualMaxUid = Math.max(...allUidsCached);
    }
    diag.actual_max_uid = actualMaxUid;
    // storedLastUid がサーバの最大 UID を超えていたら (過去バグや手動編集) キャップ
    if (effectiveLastUid > actualMaxUid) {
      console.warn(`[${account.email_address}] effectiveLastUid(${effectiveLastUid}) > actualMaxUid(${actualMaxUid}), capping`);
      effectiveLastUid = actualMaxUid;
      fromUid = actualMaxUid + 1;
    }

    // 1 回あたりの処理上限。Edge Function の wall clock を考慮して抑えめに。
    const MAX_PER_RUN = 30;
    let processed = 0;
    let maxSeenUid = effectiveLastUid;
    const touchedThreads = new Map<string, string>();

    // 同期済みの最古・最新 UID を DB から取得
    const [{ data: oldestRow }, { data: newestRow }] = await Promise.all([
      sb.from("messages")
        .select("imap_uid")
        .eq("account_id", account.id)
        .order("imap_uid", { ascending: true })
        .limit(1)
        .maybeSingle(),
      sb.from("messages")
        .select("imap_uid")
        .eq("account_id", account.id)
        .order("imap_uid", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const oldestSyncedUid = oldestRow ? Number(oldestRow.imap_uid) : null;
    const newestSyncedUid = newestRow ? Number(newestRow.imap_uid) : null;
    diag.oldest_synced_uid = oldestSyncedUid;
    diag.newest_synced_uid = newestSyncedUid;

    // lastUid が 0 にリセットされているが DB にメッセージが存在する場合、
    // DB の最大 UID を lastUid として採用 (過去の sync が途中で落ちて last_uid が
    // 更新されなかった場合の自動復旧)。これをやらないと forward search が UID 1 から
    // スキャンして既に DB にある古い UID を再フェッチし続けてしまう。
    if (effectiveLastUid === 0 && newestSyncedUid !== null) {
      console.log(`[${account.email_address}] RECOVER lastUid=${newestSyncedUid} from DB`);
      effectiveLastUid = newestSyncedUid;
      fromUid = newestSyncedUid + 1;
      maxSeenUid = newestSyncedUid;
    }

    // 同期モード判定:
    // - first: まだ何も同期していない → sequence 末尾から N 件
    // - forward: 新着あり → SEARCH で UID 列挙
    // - backfill: 過去メール未取得 → SEARCH で UID 列挙 (新しい順先頭 N 件)
    // - idle: 同期済み
    //
    // 全モードで「対象 UID リストを先に確定 → fetchOne で 1 件ずつ取得」方式にする。
    // 以前の range fetch (例: 182601:182680) は imapflow の iterator が
    // 1 件目 upsert 後に次の FETCH 応答を待って永久停止するサーバ挙動で詰まるため。
    let mode: "first" | "forward" | "backfill" | "idle";
    let targetUids: number[] = [];

    if (effectiveLastUid === 0 && oldestSyncedUid === null) {
      // first モードも SEARCH + fetchOne に統一 (range fetch の hang を回避)
      mode = "first";
      if (allUidsCached.length > 0) {
        const sorted = [...allUidsCached].sort((a, b) => b - a); // 新しい順
        targetUids = sorted.slice(0, MAX_PER_RUN).sort((a, b) => a - b);
      }
    } else if (actualMaxUid > effectiveLastUid) {
      mode = "forward";
      console.log(`[${account.email_address}] FORWARD search ${effectiveLastUid + 1}:${actualMaxUid}`);
      const r = await client.search(
        { uid: `${effectiveLastUid + 1}:${actualMaxUid}` },
        { uid: true },
      );
      const uids = (r ?? []).map((u: unknown) => Number(u)).filter((n) => !isNaN(n));
      uids.sort((a, b) => a - b); // 古い順で順に上書きしやすく
      targetUids = uids.slice(0, MAX_PER_RUN);
    } else if (oldestSyncedUid !== null && oldestSyncedUid > 1) {
      mode = "backfill";
      console.log(`[${account.email_address}] BACKFILL search 1:${oldestSyncedUid - 1}`);
      const r = await client.search(
        { uid: `1:${oldestSyncedUid - 1}` },
        { uid: true },
      );
      const uids = (r ?? []).map((u: unknown) => Number(u)).filter((n) => !isNaN(n));
      uids.sort((a, b) => b - a); // 新しい順
      targetUids = uids.slice(0, MAX_PER_RUN);
    } else {
      mode = "idle";
    }
    diag.mode = mode;
    diag.target_uid_count = targetUids.length;

    // 全モードで SEARCH → fetchOne 統一 (range fetch は一切使わない)
    // 個々の fetchOne に 15 秒タイムアウト、失敗時はスキップして次へ。
    // 連続 3 件スキップしたら imapflow の状態が壊れた可能性が高いので打ち切り。
    // スキップした UID は maxSeenUid に反映して last_uid を前進させる
    // (そうしないと次回も同じ UID で失敗する無限ループに陥る)。
    // 添付が大きいメール (数MB〜) だと 15s では source DL が間に合わず timeout するため 45s に拡大。
    // MAX_CONSECUTIVE_SKIPS=3 と組み合わせて最悪 135s で中断するので Edge Function の wall clock 内に収まる。
    const FETCH_TIMEOUT_MS = 45_000;
    const MAX_CONSECUTIVE_SKIPS = 3;
    const skippedUids: number[] = [];
    const fetchIter = (async function* () {
      let consecutiveSkips = 0;
      for (let i = 0; i < targetUids.length; i++) {
        const uid = targetUids[i];
        console.log(`[${account.email_address}] fetchOne ${i + 1}/${targetUids.length} uid=${uid} begin`);
        try {
          const one = await Promise.race([
            client.fetchOne(
              String(uid),
              { uid: true, envelope: true, source: true, internalDate: true },
              { uid: true },
            ),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`fetchOne_timeout uid=${uid}`)), FETCH_TIMEOUT_MS),
            ),
          ]);
          console.log(`[${account.email_address}] fetchOne ${i + 1}/${targetUids.length} uid=${uid} end gotSrc=${!!(one as { source?: unknown })?.source}`);
          // fetchOne が null/undefined を返す場合は接続が壊れている (タイムアウト後の後続リクエスト等)
          if (!one) {
            console.warn(`[${account.email_address}] fetchOne uid=${uid} returned null — treating as skip`);
            skippedUids.push(uid);
            consecutiveSkips++;
            if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
              console.warn(`[${account.email_address}] ${consecutiveSkips} consecutive skips — aborting this run`);
              break;
            }
            continue;
          }
          consecutiveSkips = 0;
          yield one as never;
        } catch (e) {
          console.warn(`[${account.email_address}] fetchOne uid=${uid} PERMANENT_SKIP: ${(e as Error).message}`);
          skippedUids.push(uid);
          consecutiveSkips++;
          if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            console.warn(`[${account.email_address}] ${consecutiveSkips} consecutive skips — aborting this run`);
            break;
          }
          // continue to next UID
        }
      }
    })();
    diag.skipped_uids = skippedUids;
    console.log(`[${account.email_address}] START mode=${mode} targetUids=${targetUids.length} exists=${exists} lastUid=${effectiveLastUid} actualMaxUid=${actualMaxUid} oldestSyncedUid=${oldestSyncedUid}`);
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

      console.log(`[${account.email_address}] thread resolved uid=${msg.uid}`);
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
        console.error(`[${account.email_address}] message insert failed uid=${msg.uid}`, mErr);
        continue;
      }
      console.log(`[${account.email_address}] upserted uid=${msg.uid}`);

      // last_message_at のみ更新 (件数集計は最後にまとめて)
      touchedThreads.set(threadId!, (parsed.date ?? new Date()).toISOString());

      if (Number(msg.uid) > maxSeenUid) maxSeenUid = Number(msg.uid);

      // 3 件ごとに last_uid を DB にチェックポイント保存。
      // 途中で wall-clock shutdown / hang しても次回 sync 時に続きから再開できる。
      if (processed % 3 === 0) {
        await sb
          .from("accounts")
          .update({ last_uid: maxSeenUid, last_uidvalidity: Number(mailbox.uidValidity) })
          .eq("id", account.id);
      }
    }
    console.log(`[${account.email_address}] FETCH LOOP DONE processed=${processed} skipped=${skippedUids.length}`);

    // スキップした UID も maxSeenUid に反映 (forward / first モード)。
    // こうしないと next run で同じ UID を再試行して永久ループするため。
    // backfill モードは oldestSyncedUid より古い UID なので last_uid には影響させない。
    if (mode !== "backfill" && skippedUids.length > 0) {
      const maxSkipped = Math.max(...skippedUids);
      if (maxSkipped > maxSeenUid) {
        console.warn(`[${account.email_address}] advancing maxSeenUid past skipped UIDs: ${maxSeenUid} -> ${maxSkipped}`);
        maxSeenUid = maxSkipped;
      }
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
    console.log(`[${account.email_address}] DONE processed=${processed} maxSeenUid=${maxSeenUid}`);
  } finally {
    lock.release();
    try { await client.logout(); } catch { /* ignore */ }
    console.log(`[${account.email_address}] LOGOUT`);
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
