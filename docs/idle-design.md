# IMAP IDLE 常駐プロセス設計メモ

## Context

現状の taskul-mail は Supabase Edge Functions (`imap-sync`) を Cron で 5 分毎、フロント前面時は 60 秒毎に呼んで差分取得している。Edge Functions は短命で常駐不可 (wall clock 制約・状態保持不可) のため IMAP IDLE (新着即時通知) に使えない。Xserver VPS を CLAUDE.md で保有することが明記されており、そこに常駐プロセスを立てる方針。

**スコープ**: 本メモは**設計のみ**。実装は別セッションで行う。

## ゴール

- メール受信から UI 反映まで **3 秒以内** (現状: 最大 60 秒)
- 落ちた場合は Cron フォールバックで継続 (取りこぼしゼロ)
- 運用負荷を増やさない (ヘルスチェック・自動再起動)

## アーキテクチャ

```
┌──────────────────────────────────────────────────────────┐
│  Xserver VPS (Docker Compose)                            │
│  ┌──────────────────────────────────────────┐            │
│  │  taskul-mail-idle (Node.js + imapflow)   │            │
│  │                                          │            │
│  │  - アカウントごとに worker (1 IDLE/conn) │            │
│  │  - EXISTS 通知を受けたら Supabase に     │            │
│  │    POST /functions/v1/imap-sync          │            │
│  │    ?account_id=X&trigger=idle            │            │
│  │  - 24h ごとに IDLE を貼り直し (RFC 推奨) │            │
│  │  - 接続切れは指数バックオフで再接続      │            │
│  └──────────────────────────────────────────┘            │
│           │                                              │
│           ├─ healthz endpoint (0.0.0.0:3099/healthz)     │
│           └─ logs → docker logs / journald               │
│                                                          │
│  shared-proxy network ◀─ FileMaker / Nginx と共存        │
└──────────────────────────────────────────────────────────┘
            │ HTTPS
            ▼
   ┌───────────────────┐       ┌──────────────────┐
   │ Supabase          │       │ フロント          │
   │ - imap-sync (取得) │──────▶│ - Realtime 購読  │
   │ - mail.messages   │  push │ - UI 即時反映     │
   │ - Realtime        │       └──────────────────┘
   └───────────────────┘
            ▲
            │ 5 分毎
            │ (IDLE が落ちたときの保険)
   ┌────────┴────────┐
   │ Supabase Cron   │
   │ imap-sync       │
   └─────────────────┘
```

## 実装スタック

- **言語**: Node.js 20 (imapflow は Node 前提、Deno 移植は不要)
- **主要 dep**: `imapflow`, `pino` (ログ), `@supabase/supabase-js` (RPC / Vault 読取)
- **コンテナ**: `node:20-alpine` ベース、Docker Compose で常駐
- **ネットワーク**: CLAUDE.md 準拠で `shared-proxy` network に参加

## 認証情報の取り扱い

**方針**: IMAP パスワードは VPS に直接置かず、Supabase Vault から service_role で取得する。

1. VPS の `.env` に `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を置く
2. 起動時に `mail.accounts` を読み、各アカウントの `password_secret_id` から Vault RPC (`public.vault_decrypt_secret`) で平文を取得
3. メモリ上にのみ保持、ログには出さない
4. アカウント追加/削除は 60 秒毎に再ポーリング (または Supabase Realtime で `mail.accounts` を購読して即反映)

service_role key が VPS に置かれるが、これは Edge Functions と同格の権限であり、VPS は既に信頼境界の内側。

## worker ライフサイクル

```
spawn worker(account)
  ↓
  connect IMAP (TLS)
  ↓
  SELECT INBOX (+ Sent/Archive/... if Step 3 適用後)
  ↓
  ┌─────────────────────────────────────┐
  │  IDLE loop                          │
  │  ├─ EXISTS 通知 → POST imap-sync    │
  │  ├─ 24h 経過 → IDLE 再接続          │
  │  └─ エラー → 指数バックオフ (最大5分) │
  └─────────────────────────────────────┘
```

- **複数フォルダ対応**: 1 アカウント = 1 IMAP 接続で 1 フォルダしか IDLE できない。Sent 等もリアルタイム化したい場合は `IMAP_MULTI_ACCOUNT` 接続を立てる (メモリ負荷要検証)
- **バックオフ**: 1s → 2s → 4s → ... 最大 300s。接続失敗が続けば healthz を unhealthy にして再起動を促す

## 監視

- `GET /healthz` → 全 worker の `{account_id, connected, last_idle_at}` を返す
- Cron (Supabase 側) が動いているので、VPS が落ちても取りこぼしは発生しない。ただし**レイテンシが劣化する**ので、Slack/LW 通知で検知したい
- Docker restart policy: `unless-stopped`

## Supabase 側の変更

基本的に既存の `imap-sync` Edge Function を流用する。差分:

- `?trigger=idle` パラメータを受け取り、ログに残す (通常同期と区別)
- Rate limit: 同じ account で 3 秒以内の連続呼び出しは de-dupe (flood 防止)

## 将来の LINE WORKS Bot 通知

IDLE が動いている前提で、`imap-sync` 内に「重要メール判定」(ルールベース or Claude 分類) を追加 → LINE WORKS Bot API で担当者にプッシュ。これは PoC 対象外だが、IDLE ができてから着手。

## 実装順序 (別セッションで着手時)

1. VPS の Node.js 環境準備 + Docker Compose skeleton
2. アカウント 1 つ限定で IDLE + POST imap-sync の最小動作を確認
3. マルチアカウント・再接続・ヘルスチェック対応
4. 既存の Cron はそのまま残し、**IDLE を追加投入する形で冗長化**
5. 3 日程度 stage で並行運用 → 取りこぼしがないことを確認してから本番化

## リスク

- IMAP サーバ側のセッション数制限に抵触する可能性 (Xserver の通常プランは 1 アカウント 5〜10 接続まで)。既存の同期 + IDLE + ユーザのメーラで接続数が合算される
- Node プロセスが暴走したときの自動復旧は Docker restart に任せるが、接続リークで IMAP 側が接続拒否する場合は検知困難。定期的に `HEALTH` コマンドで接続状態を調べる必要あり

## 参考

- imapflow IDLE docs: https://imapflow.com/module-imapflow-ImapFlow.html#idle
- RFC 2177 (IMAP IDLE): 24 分毎に再送が推奨
- SvelteKit 側は既に Supabase Realtime 購読済みなので、VPS → Supabase への push が入れば UI は自動更新される
