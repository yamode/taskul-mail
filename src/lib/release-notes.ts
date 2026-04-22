export interface ReleaseNote {
  version: string;
  date: string;
  changes: string[];
}

export const releaseNotes: ReleaseNote[] = [
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
