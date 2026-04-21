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

async function syncOneAccount(account: AccountRow) {
  const sb = adminClient();
  const password = await readSecret(sb, account.password_secret_id);

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.username, pass: password },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const mailbox = client.mailbox;
    if (typeof mailbox === "boolean") throw new Error("mailbox not open");

    // UIDVALIDITY 変化検知
    let fromUid = account.last_uid + 1;
    if (
      account.last_uidvalidity !== null &&
      Number(mailbox.uidValidity) !== account.last_uidvalidity
    ) {
      console.warn(`UIDVALIDITY changed for ${account.email_address}, resetting`);
      fromUid = 1;
    }

    let maxSeenUid = account.last_uid;

    // 差分フェッチ (source は本文込み)
    for await (const msg of client.fetch(
      `${fromUid}:*`,
      { uid: true, envelope: true, source: true, internalDate: true },
      { uid: true },
    )) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);

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
          .from("mail_messages")
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
          .from("mail_threads")
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
            .from("mail_threads")
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
      const { error: mErr } = await sb.from("mail_messages").upsert(
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
          raw_headers: Object.fromEntries(parsed.headers ?? []),
        },
        { onConflict: "account_id,imap_uid" },
      );
      if (mErr) {
        console.error("message insert failed", mErr);
        continue;
      }

      // スレッドのメタ情報更新
      await sb
        .from("mail_threads")
        .update({
          last_message_at: (parsed.date ?? new Date()).toISOString(),
          message_count: (await sb
            .from("mail_messages")
            .select("id", { count: "exact", head: true })
            .eq("thread_id", threadId!)).count ?? 0,
        })
        .eq("id", threadId!);

      if (Number(msg.uid) > maxSeenUid) maxSeenUid = Number(msg.uid);
    }

    // アカウントの同期ステート更新
    await sb
      .from("mail_accounts")
      .update({
        last_uid: maxSeenUid,
        last_uidvalidity: Number(mailbox.uidValidity),
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", account.id);
  } finally {
    lock.release();
    await client.logout();
  }
}

Deno.serve(async (req) => {
  // 単発アカウント指定 or 全件
  const url = new URL(req.url);
  const accountId = url.searchParams.get("account_id");

  const sb = adminClient();
  const q = sb
    .from("mail_accounts")
    .select(
      "id,email_address,imap_host,imap_port,username,password_secret_id,last_uid,last_uidvalidity",
    );
  const { data: accounts, error } = accountId
    ? await q.eq("id", accountId)
    : await q;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const results: Record<string, string> = {};
  for (const acc of (accounts ?? []) as AccountRow[]) {
    try {
      await syncOneAccount(acc);
      results[acc.email_address] = "ok";
    } catch (e) {
      console.error(`sync failed for ${acc.email_address}`, e);
      results[acc.email_address] = `error: ${(e as Error).message}`;
    }
  }

  return new Response(JSON.stringify({ results }), {
    headers: { "content-type": "application/json" },
  });
});
