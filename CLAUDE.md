# CLAUDE.md — tasukul-mail

Claude Code 用の常駐文脈。

## プロジェクト概要

YAMADO 内製の複数 IMAP アカウント統合メールクライアント。Xserver の代表アドレス (`info@`等) と個人アドレスを一元管理し、Claude API による返信下書き生成で業務効率化する。tasukul 系アプリの一つ。

## スタック

- SvelteKit (Svelte 5 runes) + TypeScript
- Cloudflare Pages (adapter-cloudflare)
- Supabase: Postgres, Auth, Edge Functions (Deno), Vault, Storage
- Anthropic Claude API (`claude-sonnet-4-5-20250929`)
- IMAP: `imapflow` / Parser: `mailparser` / SMTP: `nodemailer`

## アーキテクチャ前提

- IMAP/SMTP パスワードは **必ず** Supabase Vault (`vault.secrets`)。平文で DB に置かない。
- Edge Functions は **service_role** で実行し、Vault RPC (`public.vault_create_secret` / `vault.decrypted_secrets`) 経由でアクセス。
- フロントから `mail_accounts` に直接 insert させない。`register-account` Function 経由のみ。
- 差分同期は UIDVALIDITY + last_uid で管理。UIDVALIDITY が変わったら全再取得。

## RLS 方針

- 個人アドレス: `owner_id = auth.uid()` のみアクセス可
- 共有アドレス: `is_shared = true` かつ `mail_account_members` に自分がいる場合のみアクセス可
- 既読は `mail_message_reads` で個別記録、同じ共有アカウントのメンバーは互いの既読が見える (「誰が読んだか」の可視化)
- `has_account_access()` Postgres 関数で一元化

## 同期ジョブ

- `imap-sync` Edge Function を Cron で 5 分毎に呼ぶ
- 個別同期は `?account_id=xxx` で呼べる (UI の「今すぐ同期」ボタン用)

## Claude による下書き生成

- `generate-draft` Function がスレッド履歴 (最大 10 件, 各 2000 字) を含めて Claude に投げる
- JSON 厳守プロンプト、レスポンスからコードフェンスを除去してパース
- 生成された下書きは `mail_drafts` に `generated_by_ai=true` で保存

## 開発フロー

- main / dev 2 ブランチ構成
- Supabase Branching で dev/prod の DB 分離
- 新 Function 追加時は `supabase functions deploy <name>` で個別デプロイ

## 既知の注意点

- Xserver の 1 日あたり送信通数制限あり (プランにより異なる)。自動送信は PoC では実装しない
- Cloudflare Pages の Function タイムアウトに注意。重い同期は Edge Functions 側で完結させる
- UIDVALIDITY の持続性は IMAP サーバ実装依存。リセット時の挙動を必ずテスト
- `nodemailer` は Edge Runtime (Deno) で動くが、一部 Node API は polyfill 必要。動作しない場合は `denomailer` への切り替え検討

## 後続フェーズ (PoC 対象外)

- LINE WORKS Bot による着信通知
- Xserver VPS 側に IMAP IDLE 常駐プロセスを置いて準リアルタイム化
- 分類ルール、テンプレート学習、自動送信
- 他 tasukul アプリとの連携 (メール → タスク化)
