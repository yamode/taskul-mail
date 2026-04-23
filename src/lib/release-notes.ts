export interface ReleaseNote {
  version: string;
  date: string;
  changes: string[];
}

export const releaseNotes: ReleaseNote[] = [
  {
    version: "0.19.0",
    date: "2026-04-23",
    changes: [
      "Claude 返信下書きへのフィードバック機能: 👍 / 👎 + コメントを返信画面の 3 段目で入力可能。評価は次回以降の生成プロンプトに注入される",
      "送信時に AI 原文と実際の送信本文の差分も自動保存し、同じ相手への返信では直近 3 件を優先参照する",
      "メール一覧ヘッダの 3 段目に「一括既読」ボタンを移動。サイドバーの ✓✓ とフォルダ展開 ▾ の被りを解消",
    ],
  },
  {
    version: "0.18.1",
    date: "2026-04-23",
    changes: [
      "フォルダナビをアコーディオン化: 各アカウント右側の ▾ ボタンで開閉。デフォルトは閉。受信トレイを選択した状態がアカウントクリックの既定動作",
    ],
  },
  {
    version: "0.18.0",
    date: "2026-04-23",
    changes: [
      "フォルダナビ追加 (Step 3c): アカウントを選択すると受信トレイ / 送信済み / アーカイブの切替ボタンが出現。フォルダごとの未読バッジも表示",
      "選択したフォルダはアカウント別に localStorage に保存され、再訪時も維持される",
      "スレッド一覧は選択中フォルダのメッセージを持つスレッドだけにフィルタされる",
    ],
  },
  {
    version: "0.17.0",
    date: "2026-04-23",
    changes: [
      "Sent / Archive フォルダの本体同期 (Step 3b): imap-sync が INBOX だけでなく Sent/Archive も巡回し、フォルダごとに UIDVALIDITY / last_uid / highest_modseq を独立管理するように",
      "Sent メールは direction='outbound' として messages に記録。CONDSTORE フラグ同期・削除検出もフォルダ単位で動作",
      "raw IMAP の SELECT はフォルダ名を引用符で囲むように (Japanese / スペース含む名前への備え)",
    ],
  },
  {
    version: "0.16.1",
    date: "2026-04-23",
    changes: [
      "imap-sync 実行時に IMAP LIST でフォルダ一覧を取得し、SPECIAL-USE / 名前推定で mail.folders を自動 upsert (Step 3b 前段)",
    ],
  },
  {
    version: "0.16.0",
    date: "2026-04-23",
    changes: [
      "taskul-mail で既読化したメールを IMAP サーバにも \\Seen として反映 (逆方向同期): 新 Edge Function imap-mark-seen が UID STORE を実行",
      "共有アカウントは per-user 既読を保つため対象外 (個人アカウントのみ)",
    ],
  },
  {
    version: "0.15.0",
    date: "2026-04-23",
    changes: [
      "他 IMAP クライアントでの既読/削除が taskul-mail にも反映されるように: CONDSTORE (CHANGEDSINCE) でフラグ変化を差分取得、UID 突合で EXPUNGE されたメールを検出",
      "DB スキーマ: mail.folders.highest_modseq / mail.messages.server_seen / server_deleted_at を追加 (要 migration 20260423000002)",
      "一覧・スレッド表示が server_deleted_at を除外、未読判定は server_seen も加味",
    ],
  },
  {
    version: "0.14.4",
    date: "2026-04-23",
    changes: [
      "同期の取りこぼし修正: envelope 取得が一時タイムアウトした UID が永久欠落していた不具合を解消。失敗 UID は「[本文取得失敗]」の placeholder として DB に記録され、🔄 再取得ボタンから復旧可能に",
      "選択中メールのハイライトを濃色化 (#eff6ff → #bfdbfe) し視認性向上",
      "プレーンテキスト本文中の URL を自動リンク化。クリックで新しいタブで開く",
    ],
  },
  {
    version: "0.14.0",
    date: "2026-04-23",
    changes: [
      "メインメニューに検索バー追加 (件名・差出人・参加者を対象に部分一致フィルタ)。?q= 付き URL で状態を共有可能",
      "メール一覧に 📎 添付バッジを表示。スレッド内のいずれかのメッセージに添付があれば件名横にアイコンが出る",
      "メール本文が空だった時のフォールバックを強化: body_text / body_html どちらも無い場合は「本文を取得できませんでした」パネル + 再取得ボタンを表示。同期側でも HTML→text 簡易変換 / 添付のみメールのプレースホルダー生成を追加",
      "削除の IMAP サーバ同期: 5 秒の undo 猶予を過ぎたら imap-trash Edge Function で Trash フォルダへ MOVE (COPY+STORE+EXPUNGE フォールバック)。他のメーラや Webmail でも削除状態が揃う",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-04-22",
    changes: [
      "本文取得を生 IMAP (Deno TLS + AUTHENTICATE PLAIN + UID FETCH BODY.PEEK[]) に一本化。imapflow の download() / fetchOne({source:true}) が Courier-IMAP 上で hang する問題を根本解決。「本文取得失敗」プレースホルダーの発生源を解消",
      "添付ファイル対応: 受信時に Supabase Storage (mail-attachments バケット) へアップロード、mail.attachments に登録、メッセージ詳細の末尾に一覧表示しクリックでダウンロード",
      "SASL-IR PLAIN 認証に切替えたことで、Courier の LOGIN コマンドで拒否されていたアカウント (パスワードに `}` を含むケース等) も同期可能に",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-04-22",
    changes: [
      "メール一覧の青ラベルを「アカウント名」から「そのスレッドの最新送信者 (from_name / from_address)」に変更。誰からのメールかを一目で判別できるように",
      "社内メモをスレッド単位に集約表示。詳細ペイン上部に sticky で配置し、返信・転送作成中もそのまま参照可能に (旧: メッセージごとに個別入力)",
      "アカウントごとの「📝 下書き」ボタンを受信トレイヘッダに追加。クリックで同アカウントの下書き一覧と編集ペインを詳細エリアに表示 (宛先・Cc・件名・本文編集 / 保存 / 破棄 / 送信)",
    ],
  },
  {
    version: "0.9.4",
    date: "2026-04-22",
    changes: [
      "wheel リスナーを translate で動く .thread-row から動かない親 .thread-swipe に張り替え。行が大きくずれてもポインタから外れず、メール一覧幅いっぱいまでスムーズにスワイプできるように",
    ],
  },
  {
    version: "0.9.3",
    date: "2026-04-22",
    changes: [
      "wheel スワイプは閾値到達でも即発火せず、500ms 無操作でスワイプ終了と判定して finalize (閾値越えなら削除、未達ならリセット)",
      "削除発火後は水平 wheel が 300ms 止むまで全行の wheel 処理をロック。1 ジェスチャで momentum 余波により複数行が削除されるのを防止",
    ],
  },
  {
    version: "0.9.2",
    date: "2026-04-22",
    changes: [
      "wheel 無操作タイムアウトを 120ms → 500ms に延長し、閾値を越えた時点でタイマーを待たず即発火に変更。Mac トラックパッドで時間をかけてスワイプしても途中でキャンセル扱いにならない",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-04-22",
    changes: [
      "html/body に overscroll-behavior-x: none を設定し、Mac トラックパッド 2 本指スワイプで発火するブラウザの戻るジェスチャを全面抑止",
      ".threads にも overflow-x: hidden と overscroll-behavior-x: none を追加し、グリッド内での横スクロールを完全遮断",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-04-22",
    changes: [
      "HTMLメール本文の表示に対応: body_html がある場合は iframe (sandbox) で HTML をそのまま描画。HTML / テキストのトグルで切り替え可能",
      "iframe は sandbox=\"allow-popups allow-popups-to-escape-sandbox allow-same-origin\" で JS 無効化、<base target=\"_blank\"> を注入して全リンクを新タブで開く。描画後はコンテンツ高さに自動フィット",
      "「[本文取得失敗]」プレースホルダーのメールに「🔄 本文を再取得」ボタンを追加: 指定 UID だけをピンポイント再フェッチ (imap-sync に force_uid クエリ対応を追加)",
      "**本文取得失敗が多発していた根本原因を修正**: imap-sync の simpleParser が Uint8Array を受け付けず \"input.once is not a function\" で本文パースに失敗していた (v0.8.5 の download() 経路導入以降)。Uint8Array を Buffer でラップしてから mailparser に渡すよう修正。今後の新着 HTMLメールは正しく本文取得できるようになる",
    ],
  },
  {
    version: "0.8.6",
    date: "2026-04-22",
    changes: [
      "Mac トラックパッドの 2 本指スワイプ削除が発火しない問題を修正: v0.8.1 で全入力共通で閾値を -100px → -300px に引き上げた結果、trackpad の wheel deltaX 累積では 300px に届かず実質機能していなかった",
      "pointer (タッチ/マウスドラッグ) は -300px を維持したまま、wheel 用に別途 -150px の閾値を導入 (threshold の半分) ",
    ],
  },
  {
    version: "0.8.5",
    date: "2026-04-22",
    changes: [
      "imap-sync を 2 段フェッチに変更: Phase 1 で envelope+size のみ取得 (15s)、Phase 2 で本文を取得 (45s)",
      "20MB 超のメールは本文取得をスキップし envelope-only で挿入 (件名/送信者/日付は記録、body_text は「[本文取得失敗]」プレースホルダー)",
      "本文取得がタイムアウトした場合も envelope-only で挿入するようフォールバック: hikaru.s@ のような添付が多い個人アドレスで本文 DL が 45s を超えても、少なくともメールの存在は同期される",
    ],
  },
  {
    version: "0.8.4",
    date: "2026-04-22",
    changes: [
      "imap-sync の fetchOne タイムアウトを 15s → 45s に拡大: 個人アドレス (hikaru.s@ 等) の添付が大きいメールで source DL が間に合わず毎回 PERMANENT_SKIP されていた問題を緩和",
      "MAX_CONSECUTIVE_SKIPS=3 と組み合わせて最悪 135s で中断するため Edge Function の wall clock 内に収まる",
    ],
  },
  {
    version: "0.8.3",
    date: "2026-04-22",
    changes: [
      "imap-sync: first モードでもスキップした UID を last_uid に反映するよう修正 (従来は forward モードのみ。first で特定 UID がタイムアウトすると毎回同じ UID を再試行する無限ループが発生していた)",
      "fetchOne が null/undefined を返すケース (タイムアウト後に接続が壊れて後続リクエストが応答しない) を明示的なスキップとして扱い、3連続で run を打ち切り",
    ],
  },
  {
    version: "0.8.2",
    date: "2026-04-22",
    changes: [
      "imap-sync: fetchOne タイムアウト後は break でなく continue に変更 (他の UID は取得を試みる)",
      "連続 3 件失敗したら run を打ち切り (imapflow の状態破損を想定)",
      "forward モードでスキップした UID は last_uid を前進させる (同じ壊れた UID で無限ループするのを防止、失ったメッセージはログに PERMANENT_SKIP で記録)",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-04-22",
    changes: [
      "スワイプ削除の閾値を -100px → -300px に引き上げ (誤削除防止、意図的に長く引いたときだけ発火)",
      "新規作成をモーダル形式に変更: 受信トレイ上のボタンからポップアップ。モーダル外クリック / Esc で自動的に下書き保存して閉じる",
      "アカウント全既読ボタンは確認ダイアログ省略 (即時反映)",
      "inbox-header を 2 段構成に変更: 1 段目はアカウント名のみ、2 段目に「✉ 新規作成」「✨ AI 設定」を大きめのボタンで並列配置",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-04-22",
    changes: [
      "メインメニューを「受信トレイ / アカウント / AI 設定」の 3 項目に整理 (下書き・新規作成は撤去)",
      "受信トレイ上部にアカウント固定ヘッダを追加: 選択中アカウント名と「✉ 新規作成」「✨ AI 設定」ボタン。新規作成は当該アカウントが送信元として preset される",
      "「✨ AI 設定」クリックでそのアカウントの基本トーンを編集するモーダル表示",
      "/ai-settings ページ新設: 全アカウントの基本トーンを一覧・編集",
      "サイドバーの「すべて」を撤去: 常に単一アカウントにフィルタ (選択はlocalStorage で維持、初回は先頭アカウント)",
      "アカウントホバー時に「✓✓ 全既読」ボタン表示: そのアカウントの未読メールを一括既読化",
      "Mac トラックパッド 2 本指スワイプで削除対応: クリック不要、wheel イベントから左方向の累積を検出 → 閾値超で削除",
      "サイドバー折りたたみ時はアカウント個別の同期アイコン (スピナー/⚠) を非表示に、footer 全体同期表示のみ残す",
    ],
  },
  {
    version: "0.7.3",
    date: "2026-04-22",
    changes: [
      "imap-sync の last_uid 自動復旧: last_uid=0 だが DB にメッセージがある場合は DB の最大 UID を採用して forward sync の起点にする (途中 hang で last_uid が保存されなかった場合の自動復旧)",
      "fetchOne に 15 秒のタイムアウト追加: 特定メッセージで imapflow が永久待ちになっても、そのアカウントだけ中断して次回リトライ。他のアカウントの sync は影響を受けない",
      "3 件ごとに last_uid を DB にチェックポイント保存: 途中でシャットダウンしても次回は続きから再開できる",
    ],
  },
  {
    version: "0.7.2",
    date: "2026-04-22",
    changes: [
      "default_tone カラム未作成環境でも Edge Functions が落ちないようフォールバック追加 (generate-draft / register-account / accounts 編集)",
      "imap-sync の first (初回) 同期も SEARCH + fetchOne 方式に統一: range fetch の hang を初回にも適用、recruit@ など未同期アカウントの初回同期が hang しにくくなった",
    ],
  },
  {
    version: "0.7.1",
    date: "2026-04-22",
    changes: [
      "スワイプ削除を Pointer Events に統一: Mac/Windows のマウスによる左ドラッグでも削除できるようになった (iPhone/iPad のタッチは従来どおり)",
      "水平ドラッグ確定後の click 抑止を追加: ドラッグ終了時にスレッドが意図せず開く誤動作を防止",
      "setPointerCapture でサイドバー外にカーソルが出ても追従、user-select: none でドラッグ中のテキスト選択も抑止",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-04-22",
    changes: [
      "スレッド一覧でタッチ左スワイプによる削除に対応 (iPhone/iPad 向け): 閾値 -100px でソフトデリート、連続で何件でもスワイプ可能",
      "削除時に undo トーストを 5 秒間表示、「元に戻す」で直近の削除をまとめて復元",
      "アカウントサイドバーを折りたたみ可能に: « / » ボタンでトグル (52px に収縮)、折りたたみ中はアカウント頭文字を円形アバターで表示、未読は赤ドット、状態は localStorage で永続化",
    ],
  },
  {
    version: "0.6.1",
    date: "2026-04-22",
    changes: [
      "返信コンポーズ画面にトーン表示を復活: アカウントの既定トーン (基本) と 今回の追加指示 (hint) を 2 段で表示・入力。✨ 再生成は両方を併記して Claude に渡す",
      "既定トーンが未設定のアカウントは「未設定 — アカウント設定で登録」リンクを表示",
      "generate-draft Edge Function: 基本トーンを常に適用し、追加指示があれば併記するよう変更",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-04-22",
    changes: [
      "アプリ名を「TASKUL Mail」に変更 (ヘッダー・タイトル・ログイン画面)",
      "Claude 返信トーンをアカウントごとの既定値として mail.accounts.default_tone に保存するよう変更。アカウント追加フォーム・編集モーダルから設定可能",
      "返信コンポーズ画面からトーン入力欄を撤去。✨ 再生成ボタンはアカウントの default_tone を自動で使う",
      "generate-draft Edge Function: リクエストの hint 指定が無いときはアカウントの default_tone にフォールバック",
    ],
  },
  {
    version: "0.5.2",
    date: "2026-04-22",
    changes: [
      "IMAP 同期をアカウント単位の並列呼び出しに変更: 1 アカウントがハングしても他のアカウントの新着反映を待たせない",
      "同期状態をアカウントごとに独立管理: サイドバーの各アカウント行にスピナー (同期中) / ⚠ (エラー・クリックで再試行) を表示",
      "footer の再同期ボタンに進捗表示追加 (同期中… 2/4)、最終同期時刻は全アカウントの最古を基準に集計",
    ],
  },
  {
    version: "0.5.1",
    date: "2026-04-22",
    changes: [
      "返信/転送コンポーズの操作ボタン (破棄・下書き保存・送信・Claude 再生成・トーン指示) を sticky ヘッダーに集約。引用が長くてもスクロールせずに送信できる",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-04-22",
    changes: [
      "Gmail ライクなリアルタイム UX: Supabase Realtime で mail.messages の INSERT を購読 + 15 秒ごとの軽量 DB poll で新着メールを即時反映",
      "「同期中…」表示の hang を解消: imap-sync に 45 秒タイムアウト (AbortController) を付け、前回同期時刻「X 分前」とエラー内容を footer に表示",
      "スレッド一覧にホバーアクション追加: マウスを乗せると右端に「転送」「削除」ボタンが出現、削除はゴミ箱へソフトデリート (mail.threads.trashed_at)",
      "返信/転送 UI を gmail 風インライン展開に刷新: 元メール本文エリアを返信コンポーズ (To/Cc/件名/本文 + 折りたたみ引用) に置き換え、全文引用で送信",
      "Claude 再生成をコンポーズ画面内に統合: トーン指示を入れて ✨ ボタン 1 つで本文だけ差し替え、引用はそのまま維持",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-04-22",
    changes: [
      "imap-sync の hang を根本解決: forward/backfill 両モードで SEARCH + fetchOne ループ方式に統一。range fetch (182601:182680 等) で 1 件目 upsert 後に次応答待ちで永久停止するサーバ挙動を回避",
    ],
  },
  {
    version: "0.4.2",
    date: "2026-04-22",
    changes: [
      "backfill 同期のハング修正: 大きな UID 範囲 (1:oldestUid-1) を直接 fetch すると imapflow の iterator が閉じないため、先に UID SEARCH で絞り込み、新しい順 30 件だけをピンポイント fetch する方式に変更",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-04-22",
    changes: [
      "既読操作でアカウントサイドバーの未読バッジもリアルタイムに減少させる",
      "アカウントサイドバーの並びを ⋮⋮ / 共 / ラベル / 未読件数 の順に変更 (未読件数が右端に)",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-04-22",
    changes: [
      "過去メールの backfill 同期を追加: 初回・新着・過去遡りを毎 tick で自動切替 (first / forward / backfill / idle)",
      "新着スレッドの Outlook 風アニメーション追加 (スライドイン + ハイライトフェードアウト)",
      "アカウントサイドバーに未読バッジを表示 (赤い丸で件数)",
      "storedLastUid がサーバ最大 UID を超えた不整合を auto-reset から cap 方式に変更 (過去メール損失を防止)",
    ],
  },
  {
    version: "0.3.2",
    date: "2026-04-22",
    changes: [
      "imap-sync の同期ループハングを修正: fromUid:* では imapflow の iterator が閉じないサーバがあるため、fromUid:actualMaxUid で上限を明示",
      "1 tick あたりの処理上限を 5→30 に引き上げ (hang 対策が入ったため速度を戻した)",
      "処理完了ログ (FETCH LOOP DONE / DONE / LOGOUT) を追加してハング箇所を追跡可能に",
    ],
  },
  {
    version: "0.3.1",
    date: "2026-04-22",
    changes: [
      "既読記録の 403 エラーを修正: mail.message_reads の upsert が UPDATE を試みてポリシー違反になっていたため、ignoreDuplicates で INSERT のみに変更",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-04-22",
    changes: [
      "受信トレイ UI を刷新: ドロップダウンのアカウント切替を撤去し、縦に並ぶアカウントリストから 1 クリックで切替可能に",
      "メールアカウントの D&D 並び替えに対応 (mail.accounts.sort_order カラム追加、楽観的 UI 更新)",
      "再同期ボタンを強化: 押すと IMAP 同期 → スレッド再読込を1回で実行、同期中は「同期中...」表示",
      "共有アカウントには「共」バッジを表示",
    ],
  },
  {
    version: "0.2.5",
    date: "2026-04-22",
    changes: [
      "UID が飛び飛び (大量の削除履歴あり) のメールボックスで同期が進まないバグを修正",
      "初回同期は UID ではなく sequence 番号 (末尾からの件数指定) で確実に取得する方式に変更",
      "差分同期は fromUid:* (UID) で実在メッセージのみ取得、無駄な空範囲スキャンを排除",
      "stored_last_uid が実際の最大 UID を超えている不整合状態を検知したら自動的に初回同期扱いにリセット",
      "Edge Function のリアルタイムログを強化 (ハング箇所をダッシュボードから追跡可能に)",
    ],
  },
  {
    version: "0.2.4",
    date: "2026-04-22",
    changes: [
      "imap-sync が WallClockTime でシャットダウンされるバグ修正: Courier-IMAP は selected mailbox への STATUS 命令でハングするため、代わりに EXISTS から末尾シーケンス番号の UID を fetch して取得する方式に変更",
    ],
  },
  {
    version: "0.2.3",
    date: "2026-04-22",
    changes: [
      "imap-sync が Courier-IMAP サーバで1通も取り込めないバグを修正（SELECT に UIDNEXT を返さないサーバ向けに STATUS フォールバック追加）",
      "UID 範囲を fromUid:toUid で明示し 30 件/run に制限（Edge Function の wall clock 時間切れ対策）",
      "フェッチ範囲完走時は last_uid を toUid まで進めて、削除済み UID で再試行ループに入るのを防止",
    ],
  },
  {
    version: "0.2.2",
    date: "2026-04-22",
    changes: [
      "imap-sync のスループット改善: アカウントを Promise.all で並列同期（認証失敗アカウントが他を待たせない）",
      "スレッド message_count の再集計をメッセージごと→同期末尾でまとめて1回に変更し DB 往復を半減",
      "1 回あたりの処理上限を引き上げ、診断完了済みの AUTH PLAIN プローブを撤去",
    ],
  },
  {
    version: "0.2.1",
    date: "2026-04-22",
    changes: [
      "受信トレイのメール本文上部に sticky ツールバーを追加（返信 / 全員に返信 / 転送 / Claude 下書き）",
      "転送機能 (startForward) を新規実装（Fwd: プレフィックス・From/Date/Subject/To ヘッダー付与）",
      "返信パネルからトリガーボタンを撤去、トーン指示入力と下書き編集のみ残置",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-04-22",
    changes: [
      "受信トレイを開いている間は 60 秒ごとに自動同期、タブ復帰時に即同期する継続同期機能を追加",
      "初回同期は直近 100 件から・1 回 50 件ずつのバッチ処理で Edge Function のタイムアウトを回避",
      "imap-sync に AUTH PLAIN プローブと詳細診断ログをレスポンスに含める機能を追加",
      "Vault パスワードの読み書き時に制御文字・前後空白をサニタイズ（IMAP LOGIN プロトコルエラー対策）",
      "Edge Functions の verify_jwt を無効化（Auth が発行する ES256 token を Edge Runtime が弾くため）",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-04-20",
    changes: [
      "SvelteKit + Supabase ベースの複数 IMAP アカウント統合メールクライアント初期リリース",
      "アカウント追加・編集 UI、Vault によるパスワード安全管理",
      "受信トレイ・スレッド表示・下書き・送信・Claude による返信下書き生成",
      "共有アカウント対応（RLS + mail_account_members で「誰が読んだか」を可視化）",
    ],
  },
];
