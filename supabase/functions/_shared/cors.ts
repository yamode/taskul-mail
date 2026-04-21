// supabase/functions/_shared/cors.ts
// Cloudflare Pages / ローカル開発から Edge Functions を叩く際の CORS 対応
//
// 認証トークン (Authorization) を受け付けるので、* ではなく明示ドメイン許可リストを使う。
// 必要なら ALLOWED_ORIGINS に本番ドメイン (mail.yamado.co.jp 等) を追加する。

const ALLOWED_ORIGINS = [
  "http://localhost:5173",                         // vite dev
  "http://localhost:4173",                         // vite preview
  "https://taskul-mail.pages.dev",                 // CF Pages production
  "https://mail.yamado.co.jp",                     // 本番カスタムドメイン
];

function originAllowed(origin: string | null): string {
  if (!origin) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // preview デプロイ (xxx.taskul-mail.pages.dev) も許可
  if (/^https:\/\/[a-z0-9-]+\.taskul-mail\.pages\.dev$/i.test(origin)) return origin;
  return ALLOWED_ORIGINS[0];
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": originAllowed(origin),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

/** OPTIONS preflight を処理。通常のリクエストなら null を返す */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  return null;
}

/** JSON レスポンスに CORS ヘッダを足したものを返す */
export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(req),
    },
  });
}
