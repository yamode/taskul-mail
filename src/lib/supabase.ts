// src/lib/supabase.ts
import { createBrowserClient } from "@supabase/ssr";
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from "$env/static/public";

export const supabase = createBrowserClient(
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
);

/** mail スキーマ専用クライアント (ほぼ全ての DB 操作はこちら経由) */
export const mail = supabase.schema("mail" as any);

export function fnUrl(name: string, query?: Record<string, string>): string {
  const base = `${PUBLIC_SUPABASE_URL}/functions/v1/${name}`;
  if (!query) return base;
  const qs = new URLSearchParams(query).toString();
  return qs ? `${base}?${qs}` : base;
}

export async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}
