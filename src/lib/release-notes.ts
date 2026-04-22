export interface ReleaseNote {
  version: string;
  date: string;
  changes: string[];
}

export const releaseNotes: ReleaseNote[] = [
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
