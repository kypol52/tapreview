-- TapReview: migration 048 — AI-ассистент владельца (модуль «AI-разбор отзывов»)
--   ai_questions   — вопросы владельца и ответы (история на странице «Спросить AI», лимит вопросов в день)
--   ai_usage.kind  — добавлен вид 'ask'
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/048_ai_assistant.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.ai_usage drop constraint if exists ai_usage_kind_check;
alter table public.ai_usage add constraint ai_usage_kind_check check (kind in ('classify', 'digest', 'ask'));

create table if not exists public.ai_questions (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 300),
  answer text check (char_length(answer) <= 3000),
  source text not null default 'web' check (source in ('web', 'tg')),
  created_at timestamptz not null default now()
);
create index if not exists ai_questions_business_idx on public.ai_questions (business_id, created_at desc);

alter table public.ai_questions enable row level security;
revoke all on public.ai_questions from anon, authenticated;
grant select, insert, update, delete on public.ai_questions to service_role;

commit;
