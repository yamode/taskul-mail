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
import { Buffer } from "node:buffer";
import { adminClient, readSecret } from "../_shared/vault.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { fetchSourcesRawImap } from "../_shared/raw-imap.ts";

const ATTACHMENTS_BUCKET = "mail-attachments";

function safeFilename(name: string): string {
  // Supabase Storage のキーとして安全な形に。日本語は保持、空白・記号の一部だけ除去。
  return (name || "attachment")
    .replace(/[\x00-\x1f\x7f/\\]/g, "_")
    .slice(0, 180);
}

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

function normalizeSubject(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/gi, "").trim();
}

function snippetOf(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// 本文取得は ../_shared/raw-imap.ts の fetchSourceRawImap に一本化した。
// imapflow の download() / fetchOne({source:true}) は Courier-IMAP 上で hang するため使わない。

async function syncOneAccount(
  account: AccountRow,
  forceUid: number | null = null,
): Promise<Record<string, unknown>> {
  const sb = adminClient();
  const password = await readSecret(sb, account.password_secret_id);

  const diag: Record<string, unknown> = {
    account_last_uid: account.last_uid,
    account_last_uid_type: typeof account.last_uid,
    account_last_uidvalidity: account.last_uidvalidity,
    account_last_uidvalidity_type: typeof account.last_uidvalidity,
    force_uid: forceUid,
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
    let mode: "first" | "forward" | "backfill" | "idle" | "refetch";
    let targetUids: number[] = [];

    if (forceUid !== null) {
      // 手動再取得: 指定 UID だけを再フェッチ (既存行を upsert で上書き)
      mode = "refetch";
      targetUids = [forceUid];
      console.log(`[${account.email_address}] REFETCH uid=${forceUid}`);
    } else if (effectiveLastUid === 0 && oldestSyncedUid === null) {
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

    // 2 段フェッチ:
    //   Phase 1: imapflow で envelope + size + internalDate を UID ごとに軽量取得 (15s/件)
    //   Phase 2: 生 IMAP (Deno TLS + AUTHENTICATE PLAIN + UID FETCH BODY.PEEK[]) を
    //            1 セッション内で複数 UID まとめて連続取得。
    //            imapflow の fetchOne({source:true}) / download() は Courier 上で hang するので使わない。
    //            UID 1 件ごとの TLS+AUTH+SELECT を繰り返す旧実装は Xserver Courier で頻繁に
    //            タイムアウトしていたため、接続は 1 回に集約する。
    //   本文取得失敗時は envelope-only で挿入 (件名/送信者だけでも残す)。
    // 連続 envelope 失敗は接続異常の可能性が高いので 3 件で envelope phase を打ち切る。
    const ENVELOPE_TIMEOUT_MS = 15_000;
    const SOURCE_PER_UID_TIMEOUT_MS = 45_000;
    const MAX_SOURCE_SIZE = 25 * 1024 * 1024; // 25MB
    const MAX_CONSECUTIVE_SKIPS = 3;
    const skippedUids: number[] = [];
    let rawFetchOk = 0;
    let rawFetchFail = 0;

    // Phase 1: envelope をまとめて取得
    type Meta = Record<string, unknown> & { uid?: number; size?: number };
    const envelopes: Meta[] = [];
    {
      let consecutiveSkips = 0;
      for (let i = 0; i < targetUids.length; i++) {
        const uid = targetUids[i];
        console.log(`[${account.email_address}] envelope ${i + 1}/${targetUids.length} uid=${uid} begin`);
        let meta: Meta | null = null;
        try {
          meta = await withTimeout(
            client.fetchOne(
              String(uid),
              { uid: true, envelope: true, internalDate: true, size: true },
              { uid: true },
            ) as Promise<Meta | null>,
            ENVELOPE_TIMEOUT_MS,
            `envelope_timeout uid=${uid}`,
          );
        } catch (e) {
          console.warn(`[${account.email_address}] envelope fetch uid=${uid} FAILED: ${(e as Error).message}`);
          skippedUids.push(uid);
          consecutiveSkips++;
          if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            console.warn(`[${account.email_address}] ${consecutiveSkips} consecutive envelope skips — aborting envelope phase`);
            break;
          }
          continue;
        }
        if (!meta) {
          skippedUids.push(uid);
          consecutiveSkips++;
          if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) break;
          continue;
        }
        consecutiveSkips = 0;
        envelopes.push(meta);
      }
    }

    // Phase 2: サイズ上限以下の UID を 1 セッションで連続取得
    const bodyTargets = envelopes
      .map((m) => ({ uid: Number(m.uid), size: Number(m.size ?? 0) }))
      .filter((x) => x.uid > 0 && x.size > 0 && x.size <= MAX_SOURCE_SIZE)
      .map((x) => x.uid);
    const sourceMap = new Map<number, Uint8Array>();
    if (bodyTargets.length > 0) {
      console.log(`[${account.email_address}] raw-imap batch start uids=${bodyTargets.length}`);
      const overallTimeout = SOURCE_PER_UID_TIMEOUT_MS * bodyTargets.length + 30_000;
      const batch = await fetchSourcesRawImap({
        host: account.imap_host,
        port: account.imap_port,
        user: account.username,
        pass: password,
        uids: bodyTargets,
        perUidTimeoutMs: SOURCE_PER_UID_TIMEOUT_MS,
        overallTimeoutMs: overallTimeout,
      });
      for (const [uid, src] of batch.sources) {
        sourceMap.set(uid, src);
        rawFetchOk++;
      }
      for (const [uid, err] of batch.errors) {
        rawFetchFail++;
        console.warn(`[${account.email_address}] raw-imap batch uid=${uid} FAILED: ${err}`);
      }
      console.log(`[${account.email_address}] raw-imap batch done ok=${batch.sources.size} fail=${batch.errors.size}`);
    }

    // Phase 3: envelope + source を束ねて逐次処理
    const fetchIter = (async function* () {
      for (const meta of envelopes) {
        const uid = Number((meta as { uid?: unknown }).uid);
        const msgSize = Number((meta as { size?: unknown }).size ?? 0);
        if (msgSize > MAX_SOURCE_SIZE) {
          console.warn(`[${account.email_address}] uid=${uid} size=${msgSize} exceeds ${MAX_SOURCE_SIZE} — envelope-only`);
        } else {
          const src = sourceMap.get(uid);
          if (src) (meta as { source?: Uint8Array }).source = src;
        }
        yield meta as never;
      }
    })();
    diag.skipped_uids = skippedUids;
    console.log(`[${account.email_address}] START mode=${mode} targetUids=${targetUids.length} exists=${exists} lastUid=${effectiveLastUid} actualMaxUid=${actualMaxUid} oldestSyncedUid=${oldestSyncedUid}`);
    for await (const msg of fetchIter) {
      if (processed >= MAX_PER_RUN) break;
      processed++;
      console.log(`[${account.email_address}] got msg uid=${msg.uid} bytes=${msg.source?.length ?? 0}`);
      // source がある場合は mailparser でフルパース。
      // envelope-only フォールバックの場合は envelope から最小の parsed 相当を構築。
      // deno-lint-ignore no-explicit-any
      let parsed: any;
      if (msg.source) {
        // mailparser@3.6.9 は Buffer/string/Readable のみ受け付けるため、
        // download() / fetchOne で返ってくる Uint8Array は Buffer へ包み直す。
        // (素の Uint8Array を渡すと "input.once is not a function" で落ちる)
        const src = msg.source instanceof Uint8Array && !(msg.source instanceof Buffer)
          ? Buffer.from(msg.source.buffer, msg.source.byteOffset, msg.source.byteLength)
          : msg.source;
        parsed = await simpleParser(src);
        console.log(`[${account.email_address}] parsed uid=${msg.uid}`);
      } else if (msg.envelope) {
        const env = msg.envelope as {
          date?: Date | string;
          subject?: string;
          messageId?: string;
          inReplyTo?: string;
          from?: Array<{ name?: string; address?: string }>;
          to?: Array<{ name?: string; address?: string }>;
          cc?: Array<{ name?: string; address?: string }>;
        };
        const toValue = (arr?: Array<{ name?: string; address?: string }>) =>
          arr ? { value: arr.map((a) => ({ address: a.address, name: a.name })) } : undefined;
        parsed = {
          messageId: env.messageId,
          inReplyTo: env.inReplyTo,
          references: [],
          from: env.from?.[0] ? { value: [{ address: env.from[0].address, name: env.from[0].name }] } : undefined,
          to: toValue(env.to),
          cc: toValue(env.cc),
          subject: env.subject,
          text: "[本文取得失敗 — メールサイズが大きすぎるかサーバ応答タイムアウト。WebMail で確認してください]",
          html: null,
          date: env.date ? new Date(env.date) : (msg.internalDate ? new Date(msg.internalDate) : new Date()),
          attachments: [],
        };
        console.log(`[${account.email_address}] envelope-only uid=${msg.uid}`);
      } else {
        console.warn(`[${account.email_address}] uid=${msg.uid} has neither source nor envelope — skip`);
        continue;
      }

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
        // References/In-Reply-To でヒットしない場合のフォールバック:
        // 同件名で直近 72 時間以内のスレッドに合流、なければ新規
        // (14 日窓では「本日のご予約について」など頻出件名が誤結合するため 72h に縮小)
        const { data: recent } = await sb
          .from("threads")
          .select("id")
          .eq("account_id", account.id)
          .eq("subject_normalized", subjectNorm)
          .gte(
            "last_message_at",
            new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
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

      // 本文補完: body_text / body_html のどちらかが欠落していても表示できるようにする。
      // - text のみ空 → parsed.textAsHtml or html から推定
      // - 両方空 → 添付情報を snippet 的に入れる
      let finalText: string | null = parsed.text ?? null;
      let finalHtml: string | null = parsed.html || null;
      if (!finalText && finalHtml) {
        // HTML しかない場合でも text mode で何か出せるように簡易 strip
        finalText = String(finalHtml)
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .trim();
      }
      if (!finalText && !finalHtml) {
        const attNames = Array.isArray(parsed.attachments)
          ? parsed.attachments.map((a: { filename?: string }) => a.filename).filter(Boolean).join(", ")
          : "";
        if (attNames) {
          finalText = `(本文なし — 添付のみ: ${attNames})`;
        }
      }

      // メッセージ insert (重複は account_id+imap_uid の unique で弾く)
      const { data: upsertedMsg, error: mErr } = await sb.from("messages").upsert(
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
          body_text: finalText,
          body_html: finalHtml,
          snippet: snippetOf(finalText ?? undefined),
          received_at: (parsed.date ?? new Date()).toISOString(),
          has_attachments: (parsed.attachments?.length ?? 0) > 0,
          direction: "inbound",
          raw_headers: {},
        },
        { onConflict: "account_id,imap_uid" },
      ).select("id").single();
      if (mErr) {
        console.error(`[${account.email_address}] message insert failed uid=${msg.uid}`, mErr);
        continue;
      }
      const messageUuid = (upsertedMsg as { id: string } | null)?.id;
      console.log(`[${account.email_address}] upserted uid=${msg.uid} id=${messageUuid}`);

      // 添付ファイルを Storage にアップロードして mail.attachments へ登録。
      // 失敗してもメール本体の取得は成功扱いのまま (添付だけ欠落)。
      if (messageUuid && Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
        // 同じ UID の再同期時に重複しないよう既存レコードは全消しして入れ直す
        const { data: oldRows } = await sb
          .from("attachments")
          .select("id,storage_path")
          .eq("message_id", messageUuid);
        if (oldRows && oldRows.length > 0) {
          const paths = (oldRows as { storage_path: string | null }[])
            .map((r) => r.storage_path)
            .filter((p): p is string => !!p);
          if (paths.length > 0) {
            try { await sb.storage.from(ATTACHMENTS_BUCKET).remove(paths); } catch { /* ignore */ }
          }
          await sb.from("attachments").delete().eq("message_id", messageUuid);
        }

        for (const att of parsed.attachments as Array<{
          filename?: string;
          contentType?: string;
          size?: number;
          content?: Uint8Array | Buffer;
          cid?: string;
        }>) {
          const filename = att.filename || "attachment";
          const content = att.content;
          if (!content) continue;
          const buf = content instanceof Uint8Array && !(content instanceof Buffer)
            ? content
            : new Uint8Array((content as Buffer).buffer, (content as Buffer).byteOffset, (content as Buffer).byteLength);
          const storagePath = `${account.id}/${messageUuid}/${crypto.randomUUID()}-${safeFilename(filename)}`;
          const { error: upErr } = await sb.storage
            .from(ATTACHMENTS_BUCKET)
            .upload(storagePath, buf, {
              contentType: att.contentType || "application/octet-stream",
              upsert: false,
            });
          if (upErr) {
            console.warn(`[${account.email_address}] attachment upload failed uid=${msg.uid} name=${filename}: ${upErr.message}`);
            continue;
          }
          const { error: aErr } = await sb.from("attachments").insert({
            message_id: messageUuid,
            filename,
            content_type: att.contentType ?? null,
            size_bytes: att.size ?? buf.byteLength,
            storage_path: storagePath,
            content_id: att.cid ?? null,
          });
          if (aErr) {
            console.warn(`[${account.email_address}] attachment row insert failed uid=${msg.uid} name=${filename}: ${aErr.message}`);
          }
        }
      }

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
    // refetch モードも last_uid を動かさない (単発再取得なので既存状態を保つ)。
    if (mode !== "backfill" && mode !== "refetch" && skippedUids.length > 0) {
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

    // アカウントの同期ステート更新 (refetch モードは last_uid を触らない)
    if (mode === "refetch") {
      await sb
        .from("accounts")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", account.id);
    } else {
      await sb
        .from("accounts")
        .update({
          last_uid: maxSeenUid,
          last_uidvalidity: Number(mailbox.uidValidity),
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", account.id);
    }

    diag.processed = processed;
    diag.hit_limit = processed >= MAX_PER_RUN;
    diag.max_seen_uid = maxSeenUid;
    diag.raw_fetch_ok = rawFetchOk;
    diag.raw_fetch_fail = rawFetchFail;
    console.log(
      `[${account.email_address}] DONE processed=${processed} maxSeenUid=${maxSeenUid} rawOk=${rawFetchOk} rawFail=${rawFetchFail}`,
    );
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

  // 単発アカウント指定 or 全件。force_uid=<N> 指定時はその UID だけ再取得する。
  const url = new URL(req.url);
  const accountId = url.searchParams.get("account_id");
  const forceUidParam = url.searchParams.get("force_uid");
  const forceUid = forceUidParam !== null ? Number(forceUidParam) : null;

  if (forceUid !== null) {
    if (!accountId) {
      return jsonResponse(req, { error: "force_uid requires account_id" }, 400);
    }
    if (!Number.isFinite(forceUid) || forceUid <= 0) {
      return jsonResponse(req, { error: "force_uid must be a positive integer" }, 400);
    }
  }

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
        const diag = await syncOneAccount(acc, forceUid);
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
