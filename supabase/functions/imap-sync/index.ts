// supabase/functions/imap-sync/index.ts
// 複数 IMAP フォルダ (INBOX / Sent / Archive) を差分同期する。
// Cron (5 分毎) から呼ばれる想定。
//
// 差分同期戦略 (フォルダ単位):
//   - mail.folders.uidvalidity が変わっていたら last_uid = 0 にリセット
//   - そうでなければ last_uid + 1 以降の UID を取得
//   - message-id + in-reply-to/references で既存スレッドに合流
//
// Step 3b: 多フォルダ対応。各フォルダが独自の UIDVALIDITY / last_uid / highest_modseq を持つ。

import { ImapFlow } from "npm:imapflow@1.3.2";
import { simpleParser } from "npm:mailparser@3.6.9";
import { Buffer } from "node:buffer";
import { adminClient, readSecret } from "../_shared/vault.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { fetchSourcesRawImap } from "../_shared/raw-imap.ts";

const ATTACHMENTS_BUCKET = "mail-attachments";
// 同期対象のフォルダ role。drafts/trash/junk は本体同期しない (不要/副作用回避)。
const SYNCABLE_ROLES = new Set(["inbox", "sent", "archive"]);

function safeFilename(name: string): string {
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

type FolderRow = {
  id: string;
  name: string;
  role: string;
  uidvalidity: number | null;
  last_uid: number;
  highest_modseq: number | null;
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

type FolderDiag = Record<string, unknown>;

/**
 * フォルダ 1 つを同期する。呼び出し側で既に ImapFlow.connect() 済みであること。
 * folder.role に応じて direction と書き戻し先が変わる:
 *   - inbox/archive → direction='inbound'、inbox のみ accounts 側も mirror update
 *   - sent → direction='outbound'
 * forceUid は inbox にのみ適用 (UI の「本文再取得」は INBOX のみ)。
 */
async function syncOneFolder(
  sb: ReturnType<typeof adminClient>,
  client: ImapFlow,
  account: AccountRow,
  folder: FolderRow,
  password: string,
  forceUid: number | null,
): Promise<FolderDiag> {
  const diag: FolderDiag = {
    folder_name: folder.name,
    folder_role: folder.role,
    folder_last_uid: folder.last_uid,
    folder_uidvalidity: folder.uidvalidity,
    folder_highest_modseq: folder.highest_modseq,
  };

  const isInbox = folder.role === "inbox";
  const direction = folder.role === "sent" ? "outbound" : "inbound";
  const effectiveForceUid = isInbox ? forceUid : null;

  const lock = await client.getMailboxLock(folder.name);
  try {
    const mailbox = client.mailbox;
    if (typeof mailbox === "boolean") throw new Error(`mailbox not open: ${folder.name}`);

    const serverUidValidity = Number(mailbox.uidValidity);
    const storedLastUid = Number(folder.last_uid ?? 0);
    const storedUidValidity = folder.uidvalidity === null || folder.uidvalidity === undefined
      ? null
      : Number(folder.uidvalidity);

    diag.server_uidvalidity = serverUidValidity;
    diag.stored_last_uid = storedLastUid;
    diag.stored_uidvalidity = storedUidValidity;

    let fromUid = storedLastUid + 1;
    let effectiveLastUid = storedLastUid;
    if (storedUidValidity !== null && serverUidValidity !== storedUidValidity) {
      console.warn(`[${account.email_address}/${folder.name}] UIDVALIDITY changed, resetting`);
      fromUid = 1;
      effectiveLastUid = 0;
    }

    const exists = Number((mailbox as { exists?: number }).exists ?? 0);
    diag.exists = exists;
    diag.from_uid = fromUid;

    let actualMaxUid = 0;
    let allUidsCached: number[] = [];
    if (exists > 0) {
      const allUids = await client.search({ all: true }, { uid: true });
      allUidsCached = (allUids ?? []).map((u: unknown) => Number(u)).filter((n) => !isNaN(n));
      if (allUidsCached.length > 0) actualMaxUid = Math.max(...allUidsCached);
    }
    diag.actual_max_uid = actualMaxUid;
    if (effectiveLastUid > actualMaxUid) {
      console.warn(`[${account.email_address}/${folder.name}] effectiveLastUid(${effectiveLastUid}) > actualMaxUid(${actualMaxUid}), capping`);
      effectiveLastUid = actualMaxUid;
      fromUid = actualMaxUid + 1;
    }

    const MAX_PER_RUN = 30;
    let processed = 0;
    let maxSeenUid = effectiveLastUid;
    const touchedThreads = new Map<string, string>();

    const [{ data: oldestRow }, { data: newestRow }] = await Promise.all([
      sb.from("messages")
        .select("imap_uid")
        .eq("account_id", account.id)
        .eq("folder_id", folder.id)
        .order("imap_uid", { ascending: true })
        .limit(1)
        .maybeSingle(),
      sb.from("messages")
        .select("imap_uid")
        .eq("account_id", account.id)
        .eq("folder_id", folder.id)
        .order("imap_uid", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const oldestSyncedUid = oldestRow ? Number(oldestRow.imap_uid) : null;
    const newestSyncedUid = newestRow ? Number(newestRow.imap_uid) : null;
    diag.oldest_synced_uid = oldestSyncedUid;
    diag.newest_synced_uid = newestSyncedUid;

    if (effectiveLastUid === 0 && newestSyncedUid !== null) {
      console.log(`[${account.email_address}/${folder.name}] RECOVER lastUid=${newestSyncedUid} from DB`);
      effectiveLastUid = newestSyncedUid;
      fromUid = newestSyncedUid + 1;
      maxSeenUid = newestSyncedUid;
    }

    let mode: "first" | "forward" | "backfill" | "idle" | "refetch";
    let targetUids: number[] = [];

    if (effectiveForceUid !== null) {
      mode = "refetch";
      targetUids = [effectiveForceUid];
      console.log(`[${account.email_address}/${folder.name}] REFETCH uid=${effectiveForceUid}`);
    } else if (effectiveLastUid === 0 && oldestSyncedUid === null) {
      mode = "first";
      if (allUidsCached.length > 0) {
        const sorted = [...allUidsCached].sort((a, b) => b - a);
        targetUids = sorted.slice(0, MAX_PER_RUN).sort((a, b) => a - b);
      }
    } else if (actualMaxUid > effectiveLastUid) {
      mode = "forward";
      console.log(`[${account.email_address}/${folder.name}] FORWARD search ${effectiveLastUid + 1}:${actualMaxUid}`);
      const r = await client.search(
        { uid: `${effectiveLastUid + 1}:${actualMaxUid}` },
        { uid: true },
      );
      const uids = (r ?? []).map((u: unknown) => Number(u)).filter((n) => !isNaN(n));
      uids.sort((a, b) => a - b);
      targetUids = uids.slice(0, MAX_PER_RUN);
    } else if (oldestSyncedUid !== null && oldestSyncedUid > 1) {
      mode = "backfill";
      console.log(`[${account.email_address}/${folder.name}] BACKFILL search 1:${oldestSyncedUid - 1}`);
      const r = await client.search(
        { uid: `1:${oldestSyncedUid - 1}` },
        { uid: true },
      );
      const uids = (r ?? []).map((u: unknown) => Number(u)).filter((n) => !isNaN(n));
      uids.sort((a, b) => b - a);
      targetUids = uids.slice(0, MAX_PER_RUN);
    } else {
      mode = "idle";
    }
    diag.mode = mode;
    diag.target_uid_count = targetUids.length;

    const ENVELOPE_TIMEOUT_MS = 15_000;
    const SOURCE_PER_UID_TIMEOUT_MS = 45_000;
    const MAX_SOURCE_SIZE = 25 * 1024 * 1024;
    const MAX_CONSECUTIVE_SKIPS = 3;
    const skippedUids: number[] = [];
    let rawFetchOk = 0;
    let rawFetchFail = 0;

    // Phase 1: envelope
    type Meta = Record<string, unknown> & { uid?: number; size?: number };
    const envelopes: Meta[] = [];
    let envelopePhaseAbortedAt = -1;
    {
      let consecutiveSkips = 0;
      for (let i = 0; i < targetUids.length; i++) {
        const uid = targetUids[i];
        console.log(`[${account.email_address}/${folder.name}] envelope ${i + 1}/${targetUids.length} uid=${uid} begin`);
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
          console.warn(`[${account.email_address}/${folder.name}] envelope fetch uid=${uid} FAILED: ${(e as Error).message}`);
          skippedUids.push(uid);
          envelopes.push({ uid, size: 0, _placeholder: true });
          consecutiveSkips++;
          if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            envelopePhaseAbortedAt = i + 1;
            break;
          }
          continue;
        }
        if (!meta) {
          skippedUids.push(uid);
          envelopes.push({ uid, size: 0, _placeholder: true });
          consecutiveSkips++;
          if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            envelopePhaseAbortedAt = i + 1;
            break;
          }
          continue;
        }
        consecutiveSkips = 0;
        envelopes.push(meta);
      }
    }
    if (envelopePhaseAbortedAt >= 0) {
      targetUids = targetUids.slice(0, envelopePhaseAbortedAt);
    }

    // Phase 2: body fetch (raw IMAP batch)
    const bodyTargets = envelopes
      .map((m) => ({ uid: Number(m.uid), size: Number(m.size ?? 0) }))
      .filter((x) => x.uid > 0 && x.size > 0 && x.size <= MAX_SOURCE_SIZE)
      .map((x) => x.uid);
    const sourceMap = new Map<number, Uint8Array>();
    if (bodyTargets.length > 0) {
      console.log(`[${account.email_address}/${folder.name}] raw-imap batch start uids=${bodyTargets.length}`);
      const overallTimeout = SOURCE_PER_UID_TIMEOUT_MS * bodyTargets.length + 30_000;
      const batch = await fetchSourcesRawImap({
        host: account.imap_host,
        port: account.imap_port,
        user: account.username,
        pass: password,
        mailbox: folder.name,
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
        console.warn(`[${account.email_address}/${folder.name}] raw-imap batch uid=${uid} FAILED: ${err}`);
      }
      console.log(`[${account.email_address}/${folder.name}] raw-imap batch done ok=${batch.sources.size} fail=${batch.errors.size}`);
    }

    // Phase 3: parse & upsert
    const fetchIter = (async function* () {
      for (const meta of envelopes) {
        const uid = Number((meta as { uid?: unknown }).uid);
        const msgSize = Number((meta as { size?: unknown }).size ?? 0);
        if (msgSize > MAX_SOURCE_SIZE) {
          console.warn(`[${account.email_address}/${folder.name}] uid=${uid} size=${msgSize} exceeds ${MAX_SOURCE_SIZE} — envelope-only`);
        } else {
          const src = sourceMap.get(uid);
          if (src) (meta as { source?: Uint8Array }).source = src;
        }
        yield meta as never;
      }
    })();
    diag.skipped_uids = skippedUids;
    console.log(`[${account.email_address}/${folder.name}] START mode=${mode} targetUids=${targetUids.length} exists=${exists} lastUid=${effectiveLastUid} actualMaxUid=${actualMaxUid} oldestSyncedUid=${oldestSyncedUid}`);

    for await (const msg of fetchIter) {
      if (processed >= MAX_PER_RUN) break;
      processed++;
      console.log(`[${account.email_address}/${folder.name}] got msg uid=${msg.uid} bytes=${msg.source?.length ?? 0}`);
      // deno-lint-ignore no-explicit-any
      let parsed: any;
      if (msg.source) {
        const src = msg.source instanceof Uint8Array && !(msg.source instanceof Buffer)
          ? Buffer.from(msg.source.buffer, msg.source.byteOffset, msg.source.byteLength)
          : msg.source;
        parsed = await simpleParser(src);
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
      } else {
        parsed = {
          messageId: null,
          inReplyTo: null,
          references: [],
          from: undefined,
          to: undefined,
          cc: undefined,
          subject: null,
          text: "[本文取得失敗 — envelope 取得タイムアウト。「🔄 本文を再取得」で再試行してください]",
          html: null,
          date: msg.internalDate ? new Date(msg.internalDate as string | Date) : new Date(),
          attachments: [],
        };
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

      const isPlaceholder = parsed.subject == null && parsed.messageId == null && !parsed.from;
      const subjectNorm = isPlaceholder
        ? `__placeholder__ uid=${msg.uid}`
        : normalizeSubject(parsed.subject);
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

      if (!threadId && !isPlaceholder) {
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
              participants: [fromObj?.address, ...toAddrs, ...ccAddrs].filter(Boolean),
              last_message_at: (parsed.date ?? new Date()).toISOString(),
              message_count: 0,
            })
            .select("id")
            .single();
          if (tErr) throw tErr;
          threadId = created!.id;
        }
      }

      if (!threadId && isPlaceholder) {
        const { data: created, error: tErr } = await sb
          .from("threads")
          .insert({
            account_id: account.id,
            subject_normalized: subjectNorm,
            participants: [],
            last_message_at: (parsed.date ?? new Date()).toISOString(),
            message_count: 0,
          })
          .select("id")
          .single();
        if (tErr) throw tErr;
        threadId = created!.id;
      }

      let finalText: string | null = parsed.text ?? null;
      let finalHtml: string | null = parsed.html || null;
      if (!finalText && finalHtml) {
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

      const { data: upsertedMsg, error: mErr } = await sb.from("messages").upsert(
        {
          account_id: account.id,
          folder_id: folder.id,
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
          direction,
          raw_headers: {},
        },
        { onConflict: "account_id,folder_id,imap_uid" },
      ).select("id").single();
      if (mErr) {
        console.error(`[${account.email_address}/${folder.name}] message insert failed uid=${msg.uid}`, mErr);
        continue;
      }
      const messageUuid = (upsertedMsg as { id: string } | null)?.id;

      if (messageUuid && Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
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
            console.warn(`[${account.email_address}/${folder.name}] attachment upload failed uid=${msg.uid} name=${filename}: ${upErr.message}`);
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
            console.warn(`[${account.email_address}/${folder.name}] attachment row insert failed uid=${msg.uid} name=${filename}: ${aErr.message}`);
          }
        }
      }

      touchedThreads.set(threadId!, (parsed.date ?? new Date()).toISOString());

      if (Number(msg.uid) > maxSeenUid) maxSeenUid = Number(msg.uid);

      // チェックポイント: 3 件ごとに folder.last_uid を保存
      if (processed % 3 === 0) {
        await sb
          .from("folders")
          .update({ last_uid: maxSeenUid, uidvalidity: serverUidValidity })
          .eq("id", folder.id);
      }
    }
    console.log(`[${account.email_address}/${folder.name}] FETCH LOOP DONE processed=${processed} skipped=${skippedUids.length}`);

    // Reconcile: CONDSTORE flags + deletion detection
    const serverHighestModseq = Number((mailbox as { highestModseq?: number | string | bigint }).highestModseq ?? 0) || null;
    diag.server_highest_modseq = serverHighestModseq;
    let flagReconcileCount = 0;
    let deletionReconcileCount = 0;
    const storedHighestModseq = folder.highest_modseq;

    if (serverHighestModseq && storedHighestModseq && Number(storedHighestModseq) < serverHighestModseq) {
      try {
        const changed: Array<{ uid: number; seen: boolean }> = [];
        for await (const m of client.fetch(
          "1:*",
          { uid: true, flags: true },
          { uid: true, changedSince: BigInt(storedHighestModseq as number) },
        )) {
          const uid = Number((m as { uid?: number | bigint }).uid ?? 0);
          if (!uid) continue;
          const flags = (m as { flags?: Set<string> | string[] }).flags;
          const flagArr: string[] = flags
            ? (flags instanceof Set ? Array.from(flags) : Array.from(flags as string[]))
            : [];
          const seen = flagArr.some((f) => String(f).toLowerCase() === "\\seen");
          changed.push({ uid, seen });
        }
        diag.changedsince_count = changed.length;
        if (changed.length > 0) {
          const seenUids = changed.filter((c) => c.seen).map((c) => c.uid);
          const unseenUids = changed.filter((c) => !c.seen).map((c) => c.uid);
          if (seenUids.length > 0) {
            const { error: uErr } = await sb
              .from("messages")
              .update({ server_seen: true })
              .eq("account_id", account.id)
              .eq("folder_id", folder.id)
              .in("imap_uid", seenUids);
            if (uErr) console.warn(`[${account.email_address}/${folder.name}] server_seen update failed: ${uErr.message}`);
            else flagReconcileCount += seenUids.length;
          }
          if (unseenUids.length > 0) {
            const { error: uErr } = await sb
              .from("messages")
              .update({ server_seen: false })
              .eq("account_id", account.id)
              .eq("folder_id", folder.id)
              .in("imap_uid", unseenUids);
            if (uErr) console.warn(`[${account.email_address}/${folder.name}] server_seen unset failed: ${uErr.message}`);
            else flagReconcileCount += unseenUids.length;
          }
        }
      } catch (e) {
        console.warn(`[${account.email_address}/${folder.name}] CONDSTORE reconcile failed: ${(e as Error).message}`);
        diag.condstore_error = (e as Error).message;
      }
    } else if (!serverHighestModseq) {
      diag.condstore_supported = false;
    }

    try {
      const serverUidSet = new Set(allUidsCached);
      const { data: dbUidRows } = await sb
        .from("messages")
        .select("imap_uid")
        .eq("account_id", account.id)
        .eq("folder_id", folder.id)
        .is("server_deleted_at", null);
      const dbUids = (dbUidRows ?? [])
        .map((r) => Number((r as { imap_uid?: number }).imap_uid))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (exists > 0) {
        const missing = dbUids.filter((u) => !serverUidSet.has(u));
        if (missing.length > 0) {
          const batch = missing.slice(0, 200);
          const { error: dErr } = await sb
            .from("messages")
            .update({ server_deleted_at: new Date().toISOString() })
            .eq("account_id", account.id)
            .eq("folder_id", folder.id)
            .in("imap_uid", batch);
          if (dErr) console.warn(`[${account.email_address}/${folder.name}] server_deleted_at mark failed: ${dErr.message}`);
          else deletionReconcileCount = batch.length;
        }
      }
    } catch (e) {
      console.warn(`[${account.email_address}/${folder.name}] deletion reconcile failed: ${(e as Error).message}`);
      diag.deletion_error = (e as Error).message;
    }

    diag.flag_reconcile_count = flagReconcileCount;
    diag.deletion_reconcile_count = deletionReconcileCount;

    // touchedThreads の件数・last_message_at を更新
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

    // folder の同期ステート確定
    const folderUpdate: Record<string, unknown> = {
      last_synced_at: new Date().toISOString(),
      uidvalidity: serverUidValidity,
    };
    if (mode !== "refetch") folderUpdate.last_uid = maxSeenUid;
    if (serverHighestModseq) folderUpdate.highest_modseq = serverHighestModseq;
    await sb.from("folders").update(folderUpdate).eq("id", folder.id);

    // INBOX は accounts 側も mirror 更新 (既存 UI / IDLE worker との互換維持)
    if (isInbox) {
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
            last_uidvalidity: serverUidValidity,
            last_synced_at: new Date().toISOString(),
          })
          .eq("id", account.id);
      }
    }

    diag.processed = processed;
    diag.hit_limit = processed >= MAX_PER_RUN;
    diag.max_seen_uid = maxSeenUid;
    diag.raw_fetch_ok = rawFetchOk;
    diag.raw_fetch_fail = rawFetchFail;
    console.log(
      `[${account.email_address}/${folder.name}] DONE mode=${mode} processed=${processed} maxSeenUid=${maxSeenUid} rawOk=${rawFetchOk} rawFail=${rawFetchFail} flagReconcile=${flagReconcileCount} deletionReconcile=${deletionReconcileCount}`,
    );
  } finally {
    lock.release();
  }
  return diag;
}

async function syncOneAccount(
  account: AccountRow,
  forceUid: number | null = null,
): Promise<Record<string, unknown>> {
  const sb = adminClient();
  const password = await readSecret(sb, account.password_secret_id);

  const diag: Record<string, unknown> = {
    force_uid: forceUid,
    imap_logs: [] as string[],
    folders: {} as Record<string, FolderDiag>,
  };
  const imapLogs = diag.imap_logs as string[];
  const folderDiags = diag.folders as Record<string, FolderDiag>;

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

  try {
    // フォルダ discovery (v0.16.1): LIST → mail.folders upsert
    try {
      const list = await client.list() as Array<{
        path?: string;
        name?: string;
        specialUse?: string;
        flags?: Set<string> | string[];
      }>;
      const rows: Array<{ account_id: string; name: string; role: string; special_use: string | null }> = [];
      for (const entry of list ?? []) {
        const path = entry.path ?? entry.name;
        if (!path) continue;
        const flagSet = entry.flags instanceof Set
          ? entry.flags
          : new Set((entry.flags as string[] | undefined) ?? []);
        const special = entry.specialUse ?? (() => {
          for (const f of flagSet) {
            if (/^\\(Sent|Drafts|Trash|Junk|Archive|All|Flagged|Important)$/i.test(f)) return f;
          }
          return null;
        })();
        let role = "other";
        if (path.toUpperCase() === "INBOX") role = "inbox";
        else if (special) {
          const s = special.toLowerCase();
          if (s.includes("sent")) role = "sent";
          else if (s.includes("drafts")) role = "drafts";
          else if (s.includes("trash")) role = "trash";
          else if (s.includes("junk")) role = "junk";
          else if (s.includes("archive") || s.includes("all")) role = "archive";
        } else {
          const lower = path.toLowerCase();
          if (/(^|[./])sent($|[./])/.test(lower) || lower.endsWith("送信済み")) role = "sent";
          else if (/(^|[./])drafts?($|[./])/.test(lower) || lower.endsWith("下書き")) role = "drafts";
          else if (/(^|[./])trash($|[./])/.test(lower) || lower.includes("ゴミ箱") || lower.includes("deleted")) role = "trash";
          else if (/(^|[./])(junk|spam)($|[./])/.test(lower)) role = "junk";
          else if (/(^|[./])archive($|[./])/.test(lower) || lower.endsWith("アーカイブ")) role = "archive";
        }
        rows.push({ account_id: account.id, name: path, role, special_use: special ?? null });
      }
      if (rows.length > 0) {
        const { error: fErr } = await sb
          .from("folders")
          .upsert(rows, { onConflict: "account_id,name", ignoreDuplicates: false });
        if (fErr) console.warn(`[${account.email_address}] folders upsert failed: ${fErr.message}`);
        else diag.folders_discovered = rows.length;
      }
    } catch (e) {
      console.warn(`[${account.email_address}] LIST discovery failed: ${(e as Error).message}`);
    }

    // 同期対象フォルダを DB から読む。INBOX が無ければ最低限 seed (初回アカウントの保険)。
    const { data: folders } = await sb
      .from("folders")
      .select("id,name,role,uidvalidity,last_uid,highest_modseq")
      .eq("account_id", account.id)
      .eq("hidden", false)
      .in("role", Array.from(SYNCABLE_ROLES));
    const folderList = (folders ?? []) as FolderRow[];
    // role=inbox を先頭に並べて、以降は name 昇順で安定化
    folderList.sort((a, b) => {
      if (a.role === "inbox" && b.role !== "inbox") return -1;
      if (a.role !== "inbox" && b.role === "inbox") return 1;
      return a.name.localeCompare(b.name);
    });
    diag.folders_to_sync = folderList.map((f) => ({ name: f.name, role: f.role }));

    if (folderList.length === 0) {
      console.warn(`[${account.email_address}] no syncable folders — seeding INBOX`);
      const { data: seeded } = await sb
        .from("folders")
        .upsert(
          [{ account_id: account.id, name: "INBOX", role: "inbox", last_uid: Number(account.last_uid ?? 0), uidvalidity: account.last_uidvalidity }],
          { onConflict: "account_id,name", ignoreDuplicates: false },
        )
        .select("id,name,role,uidvalidity,last_uid,highest_modseq")
        .single();
      if (seeded) folderList.push(seeded as FolderRow);
    }

    // forceUid 指定時は INBOX 以外をスキップ (UI の「本文再取得」仕様)
    const targetFolders = forceUid !== null
      ? folderList.filter((f) => f.role === "inbox")
      : folderList;

    for (const folder of targetFolders) {
      try {
        const fdiag = await syncOneFolder(sb, client, account, folder, password, forceUid);
        folderDiags[folder.name] = fdiag;
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[${account.email_address}/${folder.name}] folder sync failed: ${msg}`);
        folderDiags[folder.name] = { error: msg, folder_role: folder.role };
        // 次のフォルダへ継続
      }
    }
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
    console.log(`[${account.email_address}] LOGOUT`);
  }
  return diag;
}

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

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
