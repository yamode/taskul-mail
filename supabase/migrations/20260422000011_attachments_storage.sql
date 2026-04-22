-- ============================================================
-- 添付ファイル用 Supabase Storage バケット + RLS
--
-- imap-sync が受信メールの添付を `mail-attachments` バケットへ upload し、
-- `mail.attachments` 行と紐付ける。フロントは supabase-js の
-- `storage.from('mail-attachments').download(path)` で取得する。
--
-- storage_path は `{account_id}/{message_uuid}/{rand}-{filename}` 形式。
-- 認可判定は先頭セグメント (account_id) に対する mail.has_account_access() で行う。
-- ============================================================

-- バケット作成 (既存なら何もしない)。private.
insert into storage.buckets (id, name, public)
values ('mail-attachments', 'mail-attachments', false)
on conflict (id) do nothing;

-- 既存ポリシーを一旦クリア (繰り返し apply しても冪等に)
drop policy if exists "mail attachments readable by account members" on storage.objects;
drop policy if exists "mail attachments service write" on storage.objects;

-- 読み取り: パスの先頭 UUID (= account_id) に対してアクセス権があれば可
create policy "mail attachments readable by account members"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'mail-attachments'
    and (
      -- パス先頭が正しい UUID フォーマットで、かつアクセス権あり
      (regexp_match(name, '^([0-9a-f-]{36})/'))[1] is not null
      and mail.has_account_access(
        ((regexp_match(name, '^([0-9a-f-]{36})/'))[1])::uuid
      )
    )
  );

-- 書き込み (insert/update/delete) は service_role のみ。
-- (service_role は RLS を bypass するので明示ポリシーは不要だが、
--  auth ユーザが誤って書けないよう認可ユーザ向けポリシーは作らない。)
