-- ============================================================
-- messages の unique 制約を partial index → 通常の unique constraint に変換
--
-- 背景:
--   migration 013 で (account_id, folder_id, imap_uid) WHERE folder_id IS NOT NULL
--   の partial unique index を作成したが、PostgREST の on_conflict は WHERE 述語を
--   渡せないため、ON CONFLICT の arbiter として推論できず 42P10 (no matching
--   unique constraint) で upsert が失敗していた。imap-sync の refetch・再同期が
--   ずっと silently fail していた原因。
--
-- 対応:
--   1. 残る NULL folder_id 行を INBOX に紐付け backfill
--   2. folder_id を NOT NULL に
--   3. partial index を削除
--   4. 通常の UNIQUE (account_id, folder_id, imap_uid) 制約を追加
-- ============================================================

-- NULL folder_id 行を INBOX に backfill
update mail.messages m
set folder_id = f.id
from mail.folders f
where f.account_id = m.account_id
  and f.role = 'inbox'
  and m.folder_id is null;

-- folder_id NOT NULL 化
alter table mail.messages alter column folder_id set not null;

-- partial index 削除
drop index if exists mail.messages_account_folder_uid_uniq;

-- 通常の unique constraint (ON CONFLICT の arbiter として PostgREST から参照可能)
alter table mail.messages
  add constraint messages_account_folder_uid_key unique (account_id, folder_id, imap_uid);
