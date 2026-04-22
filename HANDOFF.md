# HANDOFF.md — taskul-mail

> **最終更新**: 2026-04-23（v0.14.0 リリース: 検索バー・添付アイコン・本文空フォールバック・IMAP 削除同期 / dev→main force-push / カスタムドメイン準備）

## 現在地サマリ

- 受信トレイ UI（アカウント縦リスト・D&D・未読バッジ・3カラム幅調整・sticky ヘッダ・メモパネル・メインメニュー検索バー）完成して動作中
- メール一覧に 📎 添付バッジ表示
- IMAP 同期は **raw IMAP + mailparser** 方式に統一して安定稼働。imapflow の hang 問題は解決済み
- 添付ファイル取得・表示も実装済み
- 本文空フォールバック: body_html/body_text 両方空のときはパネル + 再取得ボタン表示、imap-sync 側も HTML→text 簡易変換/添付のみプレースホルダー
- 削除の IMAP サーバ同期: `imap-trash` Edge Function で Trash フォルダへ UID MOVE (COPY+STORE+EXPUNGE フォールバック)。5 秒 undo 猶予後に commit
- Supabase Realtime は `messages` / `threads` / `message_reads` / `drafts` / `folders` を購読。タブ未読バッジも動作
- **VPS IDLE worker 本番稼働中**（`~/dev/taskul-mail/idle-worker/` で Docker Compose）。新着レイテンシ 60 秒 → 3 秒以下に改善
- Cron (5 分毎) は IDLE のフォールバックとして継続稼働
- dev → main force-push 済み。カスタムドメイン `taskul-mail.yamado.app` は Cloudflare Pages 側の手動設定待ち

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

### 2026-04-23 (セッション2: v0.14.0 リリース)

**実施内容:**
- メインメニュー header に検索バー追加 (件名・差出人・参加者に部分一致、`?q=` URL 同期)
- メール一覧に 📎 添付バッジ (スレッド内のいずれかのメッセージに添付があれば表示)
- 本文空フォールバック: フロントで「本文を取得できませんでした」パネル + 再取得ボタン、imap-sync 側で HTML→text 簡易変換 / 添付のみメールのプレースホルダー自動生成
- `imap-trash` Edge Function 新設 + `raw-imap.ts` に `moveToTrashRawImap` 追加 (MOVE 優先、未対応サーバは COPY+STORE+EXPUNGE)。5 秒 undo 猶予後に IMAP サーバ側 Trash へ commit。これで他メーラ/Webmail からも削除状態が揃う
- CORS allowlist に `https://taskul-mail.yamado.app` 追加
- `supabase/config.toml`: `imap-trash` も verify_jwt=false
- **dev → main を force-push** (main は scaffold のみだった)
- Edge Functions (`imap-trash` / `imap-sync`) を prod プロジェクトへデプロイ
- **未完了 (手動作業)**: Cloudflare Pages Custom Domains に `taskul-mail.yamado.app` 追加 + Production branch が `main` になっているか確認

**バージョン:** `v0.14.0`

**コミット:**
- `5e96b36` chore: [dev] imap-trash verify_jwt=false + CORS に taskul-mail.yamado.app 追加
- `dcbb530` feat: [dev] 検索バー/添付アイコン/本文空フォールバック/IMAP 削除同期 (v0.14.0)

**残作業:**
- Cloudflare Pages カスタムドメイン設定 (手動) → `taskul-mail.yamado.app`
- CF Pages Production branch を main に設定 (まだなら)
- Sent/Archive フォルダ同期の本体（imap-sync 多フォルダ + UI フォルダナビ）
- VPS IDLE の 3 日並行運用で安定確認
- 既存メッセージのスレッド再集約関数

---

### 2026-04-23 (セッション1: v0.13.x)

**実施内容:**
- Realtime 購読拡張 (`message_reads` / `drafts` / `threads UPDATE`)、タブ未読バッジ追加
- `mail.folders` テーブル新設 + `messages.folder_id` 追加（Sent/Archive 対応の土台）
- インボックス UI 微調整: 削除ダイアログ廃止、3 カラム幅ドラッグ調整、返信/Claude 行も sticky、社内メモはメモ有り時のみ表示 + 返信行にメモボタン
- VPS IDLE worker 実装（Node.js + imapflow + Docker Compose）— 本番稼働開始、新着レイテンシ 3 秒以下
- スレッド集約フォールバック窓を 14 日 → 72 時間に短縮

**バージョン:** `v0.13.1`

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
