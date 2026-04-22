export interface ReleaseNote {
  version: string;
  date: string;
  changes: string[];
}

export const releaseNotes: ReleaseNote[] = [
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
