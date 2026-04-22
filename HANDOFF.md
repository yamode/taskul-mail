# HANDOFF.md — taskul-mail

> **最終更新**: 2026-04-23（VPS IDLE worker 稼働開始・Realtime 拡張・folders スキーマ基盤投入）

## 現在地サマリ

- 受信トレイ UI（アカウント縦リスト・D&D・未読バッジ・3カラム幅調整・sticky ヘッダ・メモパネル）完成して動作中
- IMAP 同期は **raw IMAP + mailparser** 方式に統一して安定稼働。imapflow の hang 問題は解決済み
- 添付ファイル取得・表示も実装済み
- Supabase Realtime は `messages` / `threads` / `message_reads` / `drafts` / `folders` を購読。タブ未読バッジも動作
- **VPS IDLE worker 本番稼働中**（`~/dev/taskul-mail/idle-worker/` で Docker Compose）。新着レイテンシ 60 秒 → 3 秒以下に改善
- Cron (5 分毎) は IDLE のフォールバックとして継続稼働

## アーキテクチャ

- フロント: SvelteKit + Svelte 5 runes、Cloudflare Pages (dev ブランチ)
- バックエンド: Supabase (Edge Functions, Vault, RLS, Realtime)
- IMAP: 本文取得は `_shared/raw-imap.ts` に一本化 (imapflow は hang するため不使用)
- SMTP: `nodemailer`
- IDLE: Xserver VPS 上の Node.js + imapflow コンテナ（`idle-worker/`）
- 認証: Supabase Auth (ES256)、Edge Functions は `verify_jwt = false` + 各関数で `auth.getUser(token)` 認可

## 残タスク（優先順）

### 1. Sent/Archive フォルダ同期の本体実装（Step 3b/3c）

スキーマ基盤（`mail.folders` / `messages.folder_id`）は v0.12.0 で投入済み。残りは:

- **Step 3b**: `imap-sync` Edge Function を多フォルダループ対応
  - 起動時に IMAP `LIST` で SPECIAL-USE を取得 → `mail.folders` に upsert（`\Sent` / `\Archive` / `\Trash` / `\Drafts` で role 判定）
  - folder 単位で UIDVALIDITY + last_uid を管理（現在 `mail.folders` カラム使用）
  - INBOX 以外も差分同期ループに組み込む
- **Step 3c**: UI にフォルダナビ追加
  - アカウント展開時にフォルダ一覧表示（INBOX / Sent / Archive / Trash / ...）
  - クリックで切替、フォルダ単位の未読カウント

### 2. VPS IDLE worker の安定化確認（3 日並行運用）

- `curl http://127.0.0.1:3099/healthz` で `connected: true` が維持されるか
- `docker compose logs -f` で `imap client error` や接続リークがないか
- Xserver のセッション数制限に抵触しないか（現状 5 アカウント × IDLE + Cron + ユーザメーラ）
- 3 日問題なければ本番運用確定

### 3. IDLE への機能拡張（余裕あれば）

- IDLE → Sent フォルダにも対応（現在 INBOX のみ）
- `imap-sync` に `?trigger=idle` のログ記録と rate limit (3 秒以内の de-dupe)

### 4. その他積み残し

- スレッド集約の retroactive rebuild 関数（`mail.rebuild_threads()` で既存データを再集約）
- 全文検索（tsvector）
- キーボードショートカット（j/k/e/c//）
- デスクトップ通知 / LINE WORKS Bot 通知（IDLE の新着を push）
- `hikaru.s@yamado.co.jp` の Courier-IMAP 認証問題（raw IMAP 経由でログインは通っている可能性あり、要確認）

## VPS IDLE worker の運用メモ

- 配置: `~/dev/taskul-mail/idle-worker/`
- 起動: `docker compose up -d --build`
- ログ: `docker compose logs -f`
- ヘルス: `curl http://127.0.0.1:3099/healthz`
- 設定: `.env`（`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` のみ必須）
- 更新フロー: ローカルで実装 → push → VPS で `git pull && docker compose up -d --build`

## 作業ログ

### 2026-04-23

**実施内容:**
- Realtime 購読拡張 (`message_reads` / `drafts` / `threads UPDATE`)、タブ未読バッジ追加
- スレッド集約のフォールバック窓を 14 日 → 72 時間に短縮
- `mail.folders` テーブル新設 + `messages.folder_id` 追加（Sent/Archive 対応の土台）
- `docs/idle-design.md` 作成
- インボックス UI 微調整: 削除ダイアログ廃止、3 カラム幅ドラッグ調整、返信/Claude 行も sticky、社内メモはメモ有り時のみ表示 + 返信行にメモボタン
- VPS IDLE worker 実装（Node.js + imapflow + Docker Compose）— 本番稼働開始
- アカウント行の spinner 削除（サイドバー下部に集約）

**バージョン:** `v0.13.1`

**コミット:**
- `a573afe` fix: [dev] idle-worker TS 型エラー修正 (v0.13.1)
- `ddebb5a` feat: [dev] VPS IDLE worker 実装 + アカウント行 spinner 削除 (v0.13.0)
- `9920652` fix: [dev] インボックス UI 微調整 (v0.12.1)
- `0a09176` feat: [dev] Realtime 拡張 + folders スキーマ + IDLE 設計 (v0.12.0)

**残作業:**
- Sent/Archive フォルダ同期の本体（imap-sync 多フォルダ + UI フォルダナビ）
- VPS IDLE の 3 日並行運用で安定確認
- 既存メッセージのスレッド再集約関数

## テストチェックリスト

### UI
- [ ] ログイン・ログアウトできる
- [ ] アカウントを縦リストから 1 クリックで切り替えられる
- [ ] アカウントを D&D で並び替えてリロード後も順序が維持される
- [ ] アカウントの右端に未読件数バッジが表示される
- [ ] 共有アカウントに「共」バッジが表示される
- [ ] 3 カラムそれぞれの幅をドラッグで変更、リロード後も維持される
- [ ] 返信/Claude 下書き行もヘッダとして固定される
- [ ] メモがある時だけメモパネルが表示される、返信行の「メモ」ボタンで開閉できる
- [ ] タブタイトルに未読数が出る（`(N) taskul-mail`）
- [ ] スレッドの新着がアニメーション付きで出現する

### 同期
- [ ] Cron (5 分毎) で新着が取り込まれる
- [ ] VPS IDLE worker 稼働時、新着メール受信から 3 秒以内に UI 反映
- [ ] タブ復帰時に即同期される
- [ ] 各アカウントの同期が他アカウントの失敗に引きずられない
- [ ] 添付ファイルが Storage に保存され UI からダウンロードできる

### Realtime
- [ ] 別ブラウザで既読にすると反対側の未読カウントが 1 秒以内に減る
- [ ] 別端末で下書き作成すると drafts 表示が即反映される
- [ ] ゴミ箱移動が他端末に即反映される（15 秒 poll 待ち不要）

### アカウント管理
- [ ] アカウント追加フォームから登録できる
- [ ] アカウント編集でラベル・サーバ設定・パスワードを更新できる
- [ ] アカウント削除で関連メッセージ・スレッド・下書きもカスケード削除される

### 返信・送信
- [ ] 手動返信で下書きが作成される
- [ ] Claude 下書き生成でトーン指示を付けられる
- [ ] 下書き保存・送信ができる
- [ ] 送信後にスレッド詳細が更新される

### VPS IDLE worker
- [ ] `docker compose ps` で稼働確認
- [ ] `curl http://127.0.0.1:3099/healthz` で全アカウント `connected: true`
- [ ] ログに `EXISTS push received` → `imap-sync triggered` が 3 秒以内で連続出力
- [ ] 24 分経過後も `noop` が成功している（接続健全性）
- [ ] VPS 再起動後も `unless-stopped` で自動復旧
