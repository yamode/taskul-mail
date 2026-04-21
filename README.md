# tasukul-mail

Xserver 複数 IMAP アカウント統合メールクライアント + Claude による返信下書き生成。

## スタック

- **フロント**: SvelteKit (Cloudflare Pages)
- **バック**: Supabase (Postgres / Auth / Edge Functions / Vault / Storage)
- **AI**: Anthropic Claude API (claude-sonnet-4-5 推奨、下書き品質重視)
- **メール**: IMAP/SMTP (Xserver) — 認証情報は Supabase Vault 保管

## PoC スコープ

- [x] 複数 IMAP アカウントの登録・Vault 保管
- [x] 5 分おきの差分同期 (UID ベース)
- [x] 統合受信トレイ (スレッド表示)
- [x] 代表アドレス共有 (読了者記録、未読は個別)
- [x] Claude による返信下書き生成 (スレッド文脈参照)
- [x] 下書き編集 → SMTP 送信
- [ ] 自動送信 (PoC 対象外、手動のみ)
- [ ] LINE WORKS 通知連携 (後続)

## セットアップ

### 1. Supabase プロジェクト

```bash
npm i -g supabase
supabase login
supabase init
supabase link --project-ref <YOUR_PROJECT_REF>

# Vault 拡張有効化 + mail スキーマ + RLS を適用
supabase db push
```

**⚠️ 重要**: マイグレーション適用後、Supabase Dashboard の
**Project Settings → API → "Exposed schemas"** に `mail` を追加すること。
これをしないと PostgREST / supabase-js から `mail.*` テーブルにアクセスできない
(taskul と相乗りさせる場合も忘れずに)。

### 2. 環境変数 (Edge Functions シークレット)

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx
supabase secrets set VAULT_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

### 3. フロント

```bash
cd tasukul-mail
npm install
cp .env.example .env.local
# PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY を記入
npm run dev
```

### 4. Cron 設定 (Supabase Dashboard → Database → Cron)

```sql
select cron.schedule(
  'imap-sync-all',
  '*/5 * * * *',
  $$ select net.http_post(
    url := 'https://<PROJECT>.supabase.co/functions/v1/imap-sync',
    headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')
  ) $$
);
```

## ディレクトリ

```
tasukul-mail/
├── supabase/
│   ├── migrations/           # スキーマ + RLS
│   └── functions/
│       ├── _shared/          # Vault, IMAP, SMTP ユーティリティ
│       ├── imap-sync/        # Cron 呼び出し。全アカウント差分同期
│       ├── generate-draft/   # Claude による下書き生成
│       └── send-mail/        # SMTP 送信
├── src/                      # SvelteKit
└── docs/                     # 設計ドキュメント
```

## CLAUDE.md

プロジェクトルートに `CLAUDE.md` を配置。Claude Code で作業する際の文脈を保持。
