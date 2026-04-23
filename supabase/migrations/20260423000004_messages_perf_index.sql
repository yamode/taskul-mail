-- ============================================================
-- 緊急: loadThreads() の重量クエリ用インデックス
--
-- 504 タイムアウトの原因:
--   GET /rest/v1/messages?thread_id=in.(100個)&server_deleted_at=is.null
--   &order=received_at.desc
-- messages テーブル全スキャン → 129 秒タイムアウトで Supabase 全体が詰まる。
--
-- partial index (server_deleted_at IS NULL) で存命メッセージだけを対象にし、
-- (thread_id, received_at desc) で ORDER BY を index-only で返せるようにする。
--
-- 注意:
--   - 本番適用時は CONCURRENTLY で走らせるのが望ましいが、
--     migration ファイル内の CREATE INDEX は暗黙トランザクションに入るため
--     CONCURRENTLY が使えない。SQL Editor から 1 文ずつ実行すること。
-- ============================================================

-- 1) スレッド横断で生存メッセージを received_at 降順で引くためのメイン index
create index if not exists messages_thread_received_live
  on mail.messages (thread_id, received_at desc)
  where server_deleted_at is null;

-- 2) 未読カウント用: direction='inbound' かつ生存メッセージのみ
create index if not exists messages_thread_inbound_live
  on mail.messages (thread_id, account_id)
  where server_deleted_at is null and direction = 'inbound';

-- 3) 既読判定: user_id で一気に引く
create index if not exists message_reads_user
  on mail.message_reads (user_id);

analyze mail.messages;
analyze mail.message_reads;
