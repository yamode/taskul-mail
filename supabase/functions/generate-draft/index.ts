// supabase/functions/generate-draft/index.ts
// 指定メッセージへの返信下書きを Claude に生成させる。
//
// 入力: { message_id: uuid, hint?: string }
//   message_id: 返信元メッセージ
//   hint: 「丁寧に断って」など、トーン指示
//
// 出力: { draft_id: uuid, subject: string, body_text: string }

import Anthropic from "npm:@anthropic-ai/sdk@0.68.0";
import { adminClient } from "../_shared/vault.ts";

const MODEL = "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT = `あなたは日本のビジネスメール作成を補助するアシスタントです。
以下のルールで返信下書きを生成してください。

- 日本語のビジネスメールとして自然で丁寧な文体
- 冒頭の挨拶 (「お世話になっております」等)、署名プレースホルダ ([あなたの氏名]) を含める
- 本文の主題に対して具体的に応答する。情報不足で推測が必要な箇所は [要確認: xxx] の形で明記
- 送信者が不明確な場合は「ご担当者様」とする
- 下書きなので、断定的な約束は避け、編集の余地を残す
- 返答は JSON 一つのみ。前置き・マークダウン・コードフェンス一切なし
- スキーマ: { "subject": string, "body_text": string }`;

type Msg = {
  id: string;
  account_id: string;
  thread_id: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  body_text: string | null;
  received_at: string;
};

async function authUserId(req: Request): Promise<string> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("missing auth token");
  const sb = adminClient();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) throw new Error("invalid auth");
  return data.user.id;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  try {
    const userId = await authUserId(req);
    const { message_id, hint } = await req.json();
    if (!message_id) throw new Error("message_id required");

    const sb = adminClient();

    // 返信元メッセージ取得 + アクセスチェック
    const { data: target, error: tErr } = await sb
      .from("mail_messages")
      .select(
        "id,account_id,thread_id,from_address,from_name,to_addresses,cc_addresses,subject,body_text,received_at",
      )
      .eq("id", message_id)
      .single<Msg>();
    if (tErr || !target) throw new Error("message not found");

    // service_role では auth.uid() が効かないので明示チェック
    const { data: acc } = await sb
      .from("mail_accounts")
      .select("owner_id,is_shared")
      .eq("id", target.account_id)
      .single();
    if (!acc) throw new Error("account not found");

    let allowed = acc.owner_id === userId;
    if (!allowed && acc.is_shared) {
      const { data: member } = await sb
        .from("mail_account_members")
        .select("user_id")
        .eq("account_id", target.account_id)
        .eq("user_id", userId)
        .maybeSingle();
      allowed = !!member;
    }
    if (!allowed) {
      return new Response("forbidden", { status: 403 });
    }

    // スレッド文脈: 同スレッドの過去メッセージを時系列で最大 10 件
    let thread: Msg[] = [];
    if (target.thread_id) {
      const { data } = await sb
        .from("mail_messages")
        .select(
          "id,account_id,thread_id,from_address,from_name,to_addresses,cc_addresses,subject,body_text,received_at",
        )
        .eq("thread_id", target.thread_id)
        .order("received_at", { ascending: true })
        .limit(10);
      thread = (data ?? []) as Msg[];
    }

    const contextLines = thread
      .map((m) => {
        const when = new Date(m.received_at).toLocaleString("ja-JP");
        const who = m.from_name
          ? `${m.from_name} <${m.from_address}>`
          : m.from_address ?? "不明";
        return `--- ${when} / From: ${who}\n件名: ${m.subject ?? ""}\n\n${(m.body_text ?? "").slice(0, 2000)}`;
      })
      .join("\n\n");

    const userPrompt = [
      "以下のメールスレッドに対して、最新メッセージへの返信下書きを作成してください。",
      hint ? `\n【ユーザーからの指示】\n${hint}` : "",
      "\n【スレッド履歴 (古い順)】\n",
      contextLines,
      "\n\n【返信対象 (最新)】\n",
      `件名: ${target.subject ?? ""}`,
      `From: ${target.from_name ?? ""} <${target.from_address ?? ""}>`,
      `\n${target.body_text ?? ""}`,
    ].join("\n");

    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
    });

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const rawText = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");

    // コードフェンス混入対策 (```json / ``` どちらも剥がす)
    const jsonText = rawText
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(jsonText) as { subject: string; body_text: string };

    // 下書き保存
    const { data: draft, error: dErr } = await sb
      .from("mail_drafts")
      .insert({
        account_id: target.account_id,
        author_id: userId,
        in_reply_to_message_id: target.id,
        thread_id: target.thread_id,
        to_addresses: target.from_address ? [target.from_address] : [],
        cc_addresses: [],
        subject: parsed.subject,
        body_text: parsed.body_text,
        generated_by_ai: true,
        ai_prompt_hint: hint ?? null,
        status: "draft",
      })
      .select("id,subject,body_text")
      .single();
    if (dErr) throw dErr;

    return new Response(
      JSON.stringify({
        draft_id: draft!.id,
        subject: draft!.subject,
        body_text: draft!.body_text,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
});
