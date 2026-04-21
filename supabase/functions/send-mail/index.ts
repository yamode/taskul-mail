// supabase/functions/send-mail/index.ts
// 下書きを SMTP で送信する。送信後は mail_drafts.status = 'sent' に更新し、
// mail_messages にも direction='outbound' として記録 (スレッドに並ぶよう)。
//
// 入力: { draft_id: uuid }
// 出力: { ok: true, message_id: string }

import nodemailer from "npm:nodemailer@6.9.16";
import { adminClient, readSecret } from "../_shared/vault.ts";
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
    const { draft_id } = await req.json();
    if (!draft_id) throw new Error("draft_id required");

    const sb = adminClient();

    // 下書き取得 + 作者チェック
    const { data: draft, error: dErr } = await sb
      .from("drafts")
      .select(
        "id,account_id,author_id,in_reply_to_message_id,thread_id,to_addresses,cc_addresses,bcc_addresses,subject,body_text,status",
      )
      .eq("id", draft_id)
      .single();
    if (dErr || !draft) throw new Error("draft not found");
    if (draft.author_id !== userId) {
      return new Response("forbidden", { status: 403, headers: corsHeaders(req) });
    }
    if (draft.status !== "draft") {
      throw new Error(`cannot send: status=${draft.status}`);
    }

    // アカウント情報 + パスワード
    const { data: acc, error: aErr } = await sb
      .from("accounts")
      .select(
        "id,email_address,smtp_host,smtp_port,username,password_secret_id",
      )
      .eq("id", draft.account_id)
      .single();
    if (aErr || !acc) throw new Error("account not found");

    const password = await readSecret(sb, acc.password_secret_id);

    // 返信元があれば In-Reply-To / References ヘッダを引き継ぐ
    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (draft.in_reply_to_message_id) {
      const { data: src } = await sb
        .from("messages")
        .select("message_id,message_references")
        .eq("id", draft.in_reply_to_message_id)
        .single();
      if (src?.message_id) {
        inReplyTo = src.message_id;
        references = [...(src.message_references ?? []), src.message_id];
      }
    }

    const transporter = nodemailer.createTransport({
      host: acc.smtp_host,
      port: acc.smtp_port,
      secure: acc.smtp_port === 465,
      auth: { user: acc.username, pass: password },
    });

    const info = await transporter.sendMail({
      from: acc.email_address,
      to: draft.to_addresses,
      cc: draft.cc_addresses ?? undefined,
      bcc: draft.bcc_addresses ?? undefined,
      subject: draft.subject ?? "",
      text: draft.body_text ?? "",
      inReplyTo: inReplyTo ?? undefined,
      references: references.length > 0 ? references : undefined,
    });

    // 送信済マーク + 送信メッセージを messages に記録
    const now = new Date().toISOString();
    await sb
      .from("drafts")
      .update({ status: "sent", sent_at: now })
      .eq("id", draft.id);

    // outbound として保存 (imap_uid は負値で擬似ユニーク: 重複回避)
    const pseudoUid = -Math.floor(Date.now() / 1000);
    await sb.from("messages").insert({
      account_id: acc.id,
      thread_id: draft.thread_id,
      imap_uid: pseudoUid,
      message_id: info.messageId,
      in_reply_to: inReplyTo,
      message_references: references,
      from_address: acc.email_address,
      to_addresses: draft.to_addresses,
      cc_addresses: draft.cc_addresses ?? [],
      bcc_addresses: draft.bcc_addresses ?? [],
      subject: draft.subject,
      body_text: draft.body_text,
      snippet: (draft.body_text ?? "").replace(/\s+/g, " ").slice(0, 200),
      received_at: now,
      direction: "outbound",
    });

    return jsonResponse(req, { ok: true, message_id: info.messageId });
  } catch (e) {
    return jsonResponse(req, { error: (e as Error).message }, 400);
  }
});
