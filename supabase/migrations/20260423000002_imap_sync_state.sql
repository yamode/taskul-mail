-- ============================================================
-- IMAP CONDSTORE/QRESYNC 対応のための同期ステート列
--
-- 目的:
--   - 他 IMAP クライアントでの既読/削除操作を taskul-mail に反映させる
--   - CONDSTORE (RFC 7162) の HIGHESTMODSEQ をフォルダ単位で保存
--   - 既存メッセージの \Seen フラグ (server_seen) と EXPUNGE 検出 (server_deleted_at) を記録
--
-- 読み取り側の扱い:
--   - 未読判定: message_reads に自分の行がある OR server_seen = true なら既読
--   - 一覧表示: server_deleted_at が NOT NULL のメッセージは表示から除外
--   - スレッド: 生きているメッセージ数 0 になったらリストから自然消滅
--
-- 注意: Supabase Dashboard → SQL Editor で手動実行
-- ============================================================

-- ------------------------------------------------------------
-- mail.folders.highest_modseq: CONDSTORE 用の前回同期時 MODSEQ
-- ------------------------------------------------------------
alter table mail.folders
  add column if not exists highest_modseq bigint;

-- ------------------------------------------------------------
-- mail.messages.server_seen: IMAP サーバ側の \Seen フラグ
-- 他クライアントで既読化されたメールをここに反映する
-- ------------------------------------------------------------
alter table mail.messages
  add column if not exists server_seen boolean not null default false;

-- ------------------------------------------------------------
-- mail.messages.server_deleted_at: サーバ側で EXPUNGE / 移動された検出時刻
-- NOT NULL ならクライアントの一覧から除外する (行自体は履歴として残す)
-- ------------------------------------------------------------
alter table mail.messages
  add column if not exists server_deleted_at timestamptz;

create index if not exists messages_server_deleted_idx
  on mail.messages (account_id, server_deleted_at)
  where server_deleted_at is null;
