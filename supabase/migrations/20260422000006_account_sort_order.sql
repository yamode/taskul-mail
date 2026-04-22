-- アカウントの並び順を保持する。既存行は created_at 順で初期採番。
alter table mail.accounts add column if not exists sort_order integer not null default 0;

with ranked as (
  select id, row_number() over (order by created_at) as rn
  from mail.accounts
)
update mail.accounts a set sort_order = r.rn
from ranked r
where a.id = r.id and a.sort_order = 0;

create index if not exists idx_accounts_sort_order on mail.accounts(sort_order);
