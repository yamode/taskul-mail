-- RLS 循環参照の解消
--
-- 問題: mail.accounts のポリシ → mail.account_members を参照
--       mail.account_members のポリシ → mail.has_account_access() 経由で mail.accounts を参照
--       これを Postgres が再帰として検出して "infinite recursion in policy" エラー
--
-- 解決: mail.account_members のポリシを「自分の所属レコードのみ可視」という自己参照だけに
--       オーナーが他メンバーを見たい場合は SECURITY DEFINER の専用 RPC を作る方針 (将来)

-- 既存ポリシを差し替え
drop policy if exists "members visible to account participants" on mail.account_members;

create policy "own membership readable"
  on mail.account_members for select
  using (user_id = auth.uid());

-- accounts のポリシも IN サブクエリ形式で書き直し (exists だと依存解析が雑になりがち)
drop policy if exists "own or shared accounts readable" on mail.accounts;

create policy "own or shared accounts readable"
  on mail.accounts for select
  using (
    owner_id = auth.uid()
    or (
      is_shared
      and id in (
        select account_id from mail.account_members where user_id = auth.uid()
      )
    )
  );
