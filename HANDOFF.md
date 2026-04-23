# HANDOFF.md — taskul-mail

> **最終更新**: 2026-04-23（v0.19.1: AI 下書きフィードバック機能 + DB 過負荷緊急対応 / main 反映済み）

## v0.19.1 — DB 過負荷緊急対応（main）

朝のログイン集中で Supabase プロジェクト全体が詰まり、taskul 系全アプリがログイン不能になる事故発生。原因は v0.19.0 ではなく **`loadThreads()` が 15s ごとに `messages` を全スキャンしていたクエリが DB 規模拡大で 504 タイムアウト化**。今回の AI フィードバック機能は無関係。

**対応**
- ポーリング間隔を大幅延長: `DB_POLL_INTERVAL` 15s → 120s / `IMAP_SYNC_INTERVAL` 60s → 180s。Realtime 購読があるので体感 UX への影響はほぼ無し
- `messages` に partial index 追加: `(thread_id, received_at desc) WHERE server_deleted_at IS NULL` + `(thread_id, account_id) WHERE server_deleted_at IS NULL AND direction='inbound'` + `message_reads(user_id)`
- migration `20260423000004_messages_perf_index.sql` は SQL Editor で適用済み

**教訓**
- Supabase プロジェクトを複数アプリで共有しているため、1 アプリのスロークエリが Auth まで巻き込んで全滅する構図。ポーリングは Realtime のフォールバック程度に留め、主眼は Realtime 購読にする
- 重いクエリは本番投入前に EXPLAIN で確認するか、partial index を migration に同梱すること

## v0.19.0 — Claude 返信下書きフィードバック機能（main）

返信下書きに 👍 / 👎 + コメントを付けると、次回以降の生成プロンプトに反映される学習ループを実装。

**仕組み (案 A)**
- `mail.draft_feedback` 新設（`rating` / `comment` / `ai_original_body` / `final_body` / `was_sent` / `recipient_address`）
- 返信画面 3 段目に評価 UI。送信時は AI 原文と実送信本文の差分も自動保存
- `generate-draft` が同じ送信相手の直近 3 件 + アカウント全体の直近 5 件までをプロンプトに注入。特に 👎 と「AI 生成 → 実送信」差分から学習
- `mail.drafts.ai_original_body` カラム追加（AI 原文を保持）

**副次 UI 変更**
- サイドバーの ✓✓（一括既読）がフォルダ展開 ▾ と被っていたので、メール一覧ヘッダ 3 段目に「✓✓ 一括既読 (未読数)」ボタンとして移動

**必要なデプロイ（適用済み）**
- migration `20260423000003_draft_feedback.sql`
- `supabase functions deploy generate-draft`

## v0.18.0 — フォルダナビ UI（Step 3c / dev）

アカウントを選択するとその下に「📥 受信トレイ / 📤 送信済み / 🗂 アーカイブ」のフォルダタブが出現する。

**実装ポイント**
- `foldersByAccount: Record<account_id, Folder[]>` をアプリ起動時 + 同期完了後に `mail.folders` から再読込
- `filterFolderId` を state で保持。`selectAccount` 時に localStorage (`taskul-mail.filter-folder-id:{account_id}`) から復元、無ければ inbox role のフォルダをデフォルト選択
- スレッド一覧は `threadFoldersById: Record<thread_id, Set<folder_id>>` を `applyThreads` で組み立て、`filterFolderId` が空でなければフィルタ
- 未読カウントはメッセージ単位に `folder_id` を見て集計、各フォルダ行右端に赤バッジ表示
- drafts / trash / junk は現状表示しない (`imap-sync` の SYNCABLE_ROLES と一致)

**必要なデプロイ**
- なし (フロントのみ。Cloudflare Pages の dev ブランチ auto-deploy)

**未実装 / 次**
- Sent 表示時の件名列ラベル: `to_addresses` ベースの「宛先表示」に切替 (現状は from_name のまま)
- フォルダごとの「新規作成」や「メール移動」操作
- Drafts / Trash / Junk の同期・表示

## v0.17.0 — Sent / Archive フォルダ本体同期（Step 3b / dev）

`imap-sync` を INBOX 専用から多フォルダ巡回型にリファクタ。`mail.folders` テーブルで role ∈ (`inbox`, `sent`, `archive`) のフォルダを順に同期する。

**変更点**
- `syncOneFolder()` を分離。UIDVALIDITY / last_uid / highest_modseq をフォルダ単位で管理（従来は `accounts.last_uid` だけ）
- Sent は `direction = 'outbound'` として `messages` に記録
- CONDSTORE フラグ同期・EXPUNGE 検出もフォルダ単位で独立に動作
- INBOX の同期完了時は `accounts.last_uid` / `last_uidvalidity` / `last_synced_at` も後方互換でミラー更新（IDLE worker 等の既存読み取りが壊れないように）
- `force_uid` 再取得は INBOX のみ対象（UI 仕様維持）
- raw IMAP の SELECT を `"${mailbox}"` で引用符囲みに変更（非 ASCII / スペース含むフォルダ名への備え）

**必要なデプロイ**
- `supabase functions deploy imap-sync`（migration は追加なし）

**未実装 / 次**
- Step 3c: UI フォルダナビ（アカウント展開で INBOX / Sent / Archive 切替、フォルダ単位の未読カウント）
- Drafts / Trash / Junk の同期（現状は SYNCABLE_ROLES から除外）
- 非 ASCII フォルダ名の Modified UTF-7 エンコード（現状は生文字で SELECT するため Courier 側で名前マッチしない可能性あり）

## v0.16.1 — folder discovery（Step 3b 前段）

`imap-sync` 実行時に IMAP LIST を叩いて SPECIAL-USE / 名前推定で `mail.folders` を自動 upsert する。
INBOX 同期本体のロジックは一切変更していないのでリグレッションなし。
Sent/Archive の本体同期・UI フォルダナビは次のステップ (3c)。

**role 判定**
- SPECIAL-USE フラグ優先 (`\Sent` / `\Drafts` / `\Trash` / `\Junk` / `\Archive` / `\All`)
- フォールバック: 名前推定 (`Sent` / `送信済み` / `Drafts` / `下書き` / `Trash` / `ゴミ箱` / `Archive` / `アーカイブ` / `Junk` / `Spam`)

**必要なデプロイ**
- `supabase functions deploy imap-sync`

## v0.16.0 — 逆方向 \Seen 同期（dev）

taskul-mail で既読化したメッセージを IMAP サーバ側にも `\Seen` として反映。

- 新 Edge Function `imap-mark-seen`（`verify_jwt=false`）: `{ message_ids: string[] }` を受けて UID STORE +FLAGS (\Seen) を実行
- `_shared/raw-imap.ts` に `markSeenRawImap` 追加（AUTH → SELECT → UID STORE のシンプル系）
- フロントの `markRead()` から fire-and-forget で呼び出し。**個人アカウントのみ**対象（共有は per-user 既読を保つためスキップ）
- CONDSTORE（v0.15.0）と合わせて双方向の既読同期が成立

**必要なデプロイ**
- `supabase functions deploy imap-mark-seen`
- （config.toml に verify_jwt=false 追加済み）

**未実装（次）**
- 共有アカウントの \Seen をどう扱うかのプロダクト判断（現状は意図的にスキップ）
- Sent/Archive 多フォルダ同期（Step 3b/3c）

## v0.15.0 — CONDSTORE 同期（dev）

他 IMAP クライアントで既読化・削除したメールが taskul-mail に反映されない問題を修正。

**仕組み**
- `imap-sync` の末尾に reconcile フェーズを追加
  1. **CONDSTORE フラグ同期**: `FETCH 1:* (UID FLAGS) (CHANGEDSINCE <前回MODSEQ>)` で前回以降にフラグが変わった UID だけ取得 → `messages.server_seen` を更新
  2. **削除検出**: `SEARCH ALL` で取得した現存 UID 集合と DB の UID を突合 → DB にあって server に無いものを `server_deleted_at = now()` でマーク
  3. `mail.folders.highest_modseq` に新しい MODSEQ を保存（次回の CHANGEDSINCE 起点）
- UI は `server_deleted_at IS NOT NULL` を一覧・スレッドから除外。未読判定は `server_seen = true` も既読扱い
- 逆方向（taskul-mail で既読 → サーバの \Seen セット）は未実装。必要なら imap-sync / imap-trash に STORE を追加

**必要な migration（本番適用前に SQL Editor で実行）**
- `supabase/migrations/20260423000002_imap_sync_state.sql`

**未実装 / 今後**
- 非 CONDSTORE サーバでの fallback（Xserver Courier は対応想定）
- QRESYNC `VANISHED` 活用（現状は UID diff で代用）
- 双方向 \Seen 同期（taskul-mail 側で既読化時にサーバへ STORE）
- IDLE worker での FETCH レスポンス（フラグ変更）ハンドル


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

### 1. Sent フォルダ向け表示の最適化

v0.18.0 でフォルダナビは入ったが、Sent 閲覧時の体験はまだ「受信トレイ基準」のまま:

- Sent スレッドでは件名横の青ラベルを送信先 (to_addresses[0]) にする
- outbound メッセージの未読判定は不要 (いま unread_count は inbound のみ数えているので実害なし、ただ UI 整理の余地あり)
- Drafts / Trash / Junk フォルダの本体同期・表示 (現状 SYNCABLE_ROLES から除外)

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

### 2026-04-23 (セッション4: v0.19.0 / v0.19.1 AI フィードバック + 緊急対応)

**実施内容:**
- **v0.19.0**: AI 下書きフィードバック機能 (案 A: 👍👎 + コメント + 送信時自動差分記録)。`mail.draft_feedback` 新設、`mail.drafts.ai_original_body` 追加、`generate-draft` が直近フィードバックをプロンプトに注入。返信画面 3 段目に UI
- **v0.19.0 副次**: サイドバーの一括既読 ✓✓ がフォルダ展開 ▾ と被っていたので、メール一覧ヘッダ 3 段目に移動（未読数付き）
- **障害対応**: main merge 直後に Supabase プロジェクト全体が詰まり、taskul 系全アプリがログイン不能に。ログ確認で `/rest/v1/messages?thread_id=in.(100個)&server_deleted_at=is.null&order=received_at.desc` が 129 秒 504 タイムアウト（`loadThreads()` が 15s ごとに発行）と判明。今回の修正は無関係、DB 規模拡大＋朝のログイン集中で顕在化
- **v0.19.1 緊急対応**: DB ポーリング 15s → 120s / IMAP sync 60s → 180s に延長。`messages` に partial index 追加 (`thread_id, received_at desc`) WHERE server_deleted_at IS NULL 等。SQL 適用後に 504 収束

**バージョン:** `v0.19.1`（main 反映済み）

**コミット:**
- `1986a37` feat: [dev] AI 下書きフィードバック機能 + 一括既読ボタン移動 (v0.19.0)
- `0c805f2` fix: [dev] DB 過負荷緩和 — ポーリング間隔延長 + messages index (v0.19.1)

**残作業（次セッションへ）:**
- DB Requests グラフを 1 日追跡して v0.19.1 で安定しているか確認
- フィードバックが一定数貯まったら、案 B（Claude に傾向を要約させ `account_style_notes` に保存してプロンプト注入）への拡張検討
- Supabase プロジェクト共有のリスク低減: 重いクエリは migration に partial index を同梱する運用をデフォルト化
- Sent フォルダ向け UI 最適化 (件名横ラベルを to_addresses ベースに)
- VPS IDLE worker の 3 日並行運用で安定確認
- Drafts / Trash / Junk フォルダ同期の本体
- スレッド集約 retroactive rebuild 関数

---

### 2026-04-23 (セッション3: v0.15.0 CONDSTORE 同期) — 設計メモのみ残置
- CONDSTORE `CHANGEDSINCE` で前回以降のフラグ変更を差分取得。`mail.folders.highest_modseq` を次回起点に保存
- 削除検出は `SEARCH ALL` 結果と DB UID の差分（UID diff 代用。QRESYNC `VANISHED` は未活用）
- UI は `server_deleted_at IS NOT NULL` を除外、`server_seen = true` も既読扱い

---

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
