# HANDOFF.md — taskul-mail

最終更新: 2026-04-22 (dev ブランチ v0.4.3 デプロイ済)

## 現在地サマリ

- 受信トレイの UI（アカウント縦リスト・D&D 並び替え・未読バッジ・新着アニメ・メール本文上部ツールバー）は完成して動作中。
- アカウント追加・編集・パスワード再設定・Vault 連携は完成。
- **IMAP 同期が未解決**。1 tick で 1 通だけ upsert した後に imapflow が hang し、wall-clock タイムアウトで強制終了される状態。過去メール backfill もほぼ進んでいない。

## 同期の現状と既知挙動

### アカウント別状況
- `info@yamado.co.jp` — 25 通あるうち uid=182602 以外は未取得。毎回 1 通目を upsert 後に hang。
- `reservation@yamado.co.jp` — 数通は取れている。backfill は進んでいない。
- `office@yamado.co.jp` — 1 通だけ取れている（過去の成功ログあり uid=33524）。
- `hikaru.s@yamado.co.jp` — **IMAP 認証が通らない**。Courier-IMAP が `1 NO Error in IMAP command received by server.` を返す。WebMail では同じパスワードでログインできる。診断済み（12 文字・制御文字なし・印字可能 ASCII のみ）、LOGIN コマンドとパスワード中の一部文字の相性問題の可能性。AUTHENTICATE PLAIN への切替で解決する可能性があるが未実装。

### Hang の発生パターン
1. 接続・認証・SELECT INBOX・SEARCH `{all: true}`・SEARCH `{uid: 'X:Y'}` はすべて動く。
2. fetch 系を呼ぶと 1 通返ってきた直後に次の応答を待って hang する。
   - `client.fetch(range, {source: true, ...})` でも
   - `client.fetchOne(uid, {source: true, ...})` でも同じ。
3. `source: true` を外した簡易 fetch (probe 用) は動く。
4. imapflow のバージョンを `1.0.164` → `1.3.2` に上げても解消せず。

### 直近のログパターン（再現済）
```
[info@yamado.co.jp] FORWARD search 182601:182682
[info@yamado.co.jp] START mode=forward targetUids=8 firstSyncRange=null exists=25 lastUid=182600 actualMaxUid=182682 oldestSyncedUid=176312
[info@yamado.co.jp] fetchOne 1/8 uid=182602 begin
... (以降何も出ず wall-clock 時間切れで shutdown)
```

`begin` の後に `end` が出ないので、imapflow の fetchOne 内部（`UID FETCH uid (BODY[])` の応答待ち）で止まっている。

## 次にやるべきこと（優先順）

### 同期 hang の突破
- **案A**: `client.download(uid)` で本文を別コマンドとして取得する方式を試す。`fetch` で envelope のみ取り、`download` で本文ストリームを別途読む。
- **案B**: `npm:imap` (node-imap) に置き換える。Deno で動くかは未確認。Deno の互換性は落ちるかもしれない。
- **案C**: Deno の TLS ソケット + 手書き IMAP パーサで最小実装。AUTHENTICATE PLAIN にも対応できるので hikaru.s 問題も同時解決。最大工数。
- **案D**: 1 通ごとに接続を開き直す（connect → login → select → fetchOne → logout のループ）。確実だが遅い。速度は受容できる範囲（30 通/tick × 60 秒）。

優先度: 案A → 案D → 案C。案A が効けば最小変更で解決。

### hikaru.s@yamado.co.jp の認証問題
Courier の LOGIN コマンドがパスワード `}` で拒否されるかもしれないため、AUTHENTICATE PLAIN への切替が必要。imapflow は mechanism を強制できないので、raw IMAP（案C）と同時に片付けるのが自然。

### UI 側の積み残し
- 受信メールのリアルタイム着信通知（Realtime subscription 経由の push）
- メールボックス構成（Sent / Drafts / Trash / Spam 等）の同期 — `mail.folders` テーブル新設、`client.list()` でフォルダ一覧取得、各フォルダごとに差分同期ループ、`messages.folder_id` 追加、UI にフォルダ切替サイドバー
- `mail.message_reads` に UPDATE ポリシー追加（現在は insert + ignoreDuplicates で回避中）

## アーキテクチャ状態

- フロント: SvelteKit + Svelte 5 runes、Cloudflare Pages (dev / main 2 ブランチ運用だが main 未作成)
- バックエンド: Supabase (Edge Functions, Vault, RLS)
- IMAP: `npm:imapflow@1.3.2` + `mailparser@3.6.9`
- 認証: Supabase Auth (ES256)。Edge Functions は `verify_jwt = false` で各関数内で `auth.getUser(token)` による認可を行う構成。

## 実行中のパッチ済み問題

| 問題 | 状態 | 備考 |
|---|---|---|
| ES256 JWT を Edge Runtime が拒否 | ✅ | `verify_jwt = false` で回避 |
| Vault パスワードに制御文字が入る | ✅ | `sanitizeSecret` で trim + 制御文字除去 |
| message_reads upsert の 403 | ✅ | `ignoreDuplicates: true` で INSERT のみ |
| stored_last_uid > actualMaxUid | ✅ | cap 方式で対処 |
| アカウント sort_order カラム | ⚠️ | SQL Editor で手動 apply 済み。`supabase db push` は既存 migrations と衝突するため CLI 経由では apply できない |

## 関連コミット（直近）

- `20bf56a` v0.4.3 — SEARCH + fetchOne 方式に統一
- `b7a9e70` v0.4.2 — SEARCH ベースの backfill 初版
- `7e1a891` v0.4.0 — backfill 同期モード追加 + 新着アニメ + 未読バッジ
- `4a63276` v0.4.1 — 未読バッジのリアルタイム減算 + 並び順調整
- `13519b4` v0.3.1 — message_reads 403 修正
- `910ed02` v0.3.0 — アカウント UI をリスト化 + D&D

## 検証用コマンド

```bash
# 単一アカウントで同期テスト
curl -X POST "https://ynzpjdarpfaurzomrddu.supabase.co/functions/v1/imap-sync?account_id=8845aea8-98a3-4ecb-9660-55f0e6daf518" --max-time 60

# ログ確認は Supabase Dashboard → Functions → imap-sync → Logs
# Filter: `[info@yamado.co.jp]`、Level: All
```

## テストチェックリスト

### UI
- [ ] ログイン・ログアウトできる
- [ ] アカウントを縦リストから 1 クリックで切り替えられる
- [ ] アカウントを D&D で並び替えてリロード後も順序が維持される
- [ ] アカウントの右端に未読件数バッジが表示される
- [ ] 共有アカウントに「共」バッジが表示される
- [ ] メッセージを開くとアカウント・スレッドの未読カウントが即減算される
- [ ] 受信トレイでメール本文上部のツールバー（返信 / 全員返信 / 転送 / Claude 下書き）が動作する
- [ ] スレッドの新着がアニメーション付きで出現する

### 同期
- [ ] 受信トレイを開いた状態で 60 秒後に新着が取り込まれる
- [ ] タブ復帰時に即同期される
- [ ] 過去メールが徐々に遡って取り込まれる（backfill） ← **現在 NG**
- [ ] 各アカウントの同期が他アカウントの失敗に引きずられない

### アカウント管理
- [ ] アカウント追加フォームから登録できる
- [ ] アカウント編集でラベル・サーバ設定・パスワードを更新できる
- [ ] アカウント削除で関連メッセージ・スレッド・下書きもカスケード削除される

### 返信・送信
- [ ] 手動返信で下書きが作成される
- [ ] Claude 下書き生成でトーン指示を付けられる
- [ ] 下書き保存・送信ができる
- [ ] 送信後にスレッド詳細が更新される
