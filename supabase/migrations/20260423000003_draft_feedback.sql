-- ============================================================
-- AI 下書きへのフィードバック記録
--
-- 目的:
--   ユーザが AI 生成下書きを「良い / 悪い」で評価、および送信時に
--   最終本文との差分を保存。generate-draft 側で直近のフィードバックを
--   プロンプトに注入して再生時に反映する。
--
-- 注意: SQL Editor で手動実行すること。
-- ============================================================

create table if not exists mail.draft_feedback (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references mail.drafts(id) on delete cascade,
  account_id uuid not null references mail.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating text,                                   -- 'good' | 'bad' | null (送信時自動のみ)
  comment text,                                  -- 任意コメント
  ai_original_body text,                         -- AI が生成した本文 (下書き作成時点)
  final_body text,                               -- 送信時の最終本文
  was_sent boolean not null default false,       -- 送信時 auto-capture なら true
  recipient_address text,                        -- 送信相手 (最初の to)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists draft_feedback_account_created
  on mail.draft_feedback (account_id, created_at desc);
create index if not exists draft_feedback_recipient
  on mail.draft_feedback (account_id, recipient_address);

create trigger draft_feedback_updated before update on mail.draft_feedback
  for each row execute function mail.tg_set_updated_at();

alter table mail.draft_feedback enable row level security;

-- アカウントアクセス権があるユーザのみ参照・作成可能
create policy draft_feedback_select on mail.draft_feedback
  for select to authenticated
  using (mail.has_account_access(account_id));

create policy draft_feedback_insert on mail.draft_feedback
  for insert to authenticated
  with check (mail.has_account_access(account_id) and user_id = auth.uid());

create policy draft_feedback_update on mail.draft_feedback
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy draft_feedback_delete on mail.draft_feedback
  for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on mail.draft_feedback to authenticated;
grant all on mail.draft_feedback to service_role;

-- drafts 本体にも AI 原文を保持できるようにしておく (再生成時の比較用)
alter table mail.drafts
  add column if not exists ai_original_body text;

comment on table mail.draft_feedback is
  'AI 下書きへの 👍/👎 評価と送信時の編集結果。generate-draft が直近フィードバックを参照してトーン学習する。';
