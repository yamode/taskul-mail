-- "owner manages members" は FOR ALL なので SELECT も含み、
-- そこから mail.accounts → account_members に再帰参照が発生していた。
-- SELECT は "own membership readable" でカバーしているので、
-- ここでは INSERT/UPDATE/DELETE のみに絞る。

drop policy if exists "owner manages members" on mail.account_members;

create policy "owner inserts members"
  on mail.account_members for insert
  with check (
    exists (
      select 1 from mail.accounts a
      where a.id = account_members.account_id and a.owner_id = auth.uid()
    )
  );

create policy "owner updates members"
  on mail.account_members for update
  using (
    exists (
      select 1 from mail.accounts a
      where a.id = account_members.account_id and a.owner_id = auth.uid()
    )
  );

create policy "owner deletes members"
  on mail.account_members for delete
  using (
    exists (
      select 1 from mail.accounts a
      where a.id = account_members.account_id and a.owner_id = auth.uid()
    )
  );
