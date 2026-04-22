-- ============================================================
-- アカウントごとの Claude 返信トーン設定
--
-- 注意: SQL Editor で手動実行すること。
-- ============================================================

alter table mail.accounts
  add column if not exists default_tone text not null default '';

comment on column mail.accounts.default_tone is
  'Claude で返信下書きを生成する際の既定トーン指示 (例: 丁寧に、簡潔に)。空文字なら汎用トーン。';
