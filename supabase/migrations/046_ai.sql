-- TapReview: migration 046 — модуль «AI-разбор отзывов» (YandexGPT, Yandex Cloud, Россия)
--   businesses.modules  — теперь может содержать 'ai'
--   feedback.ai_*, reviews.ai_* — разметка текста: темы (те же ключи, что у причин: wait, quality, service, clean, price, other),
--                         тон (negative / neutral / positive), «срочно» и почему, суть одной фразой, когда размечено
--   ai_usage            — сколько токенов потратили (для лимита расходов в месяц и отчёта в админке)
--   ai_digests          — еженедельная сводка «о чём пишут гости» для владельца. Цифры в ней считает код, AI только формулирует
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/046_ai.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses drop constraint if exists businesses_modules_check;
alter table public.businesses
  add constraint businesses_modules_check check (modules <@ array['service', 'ai']::text[]);

alter table public.feedback
  add column if not exists ai_topics text[],
  add column if not exists ai_tone text check (ai_tone in ('negative', 'neutral', 'positive')),
  add column if not exists ai_urgent boolean,
  add column if not exists ai_note text check (char_length(ai_note) <= 300),
  add column if not exists ai_at timestamptz;

alter table public.reviews
  add column if not exists ai_topics text[],
  add column if not exists ai_tone text check (ai_tone in ('negative', 'neutral', 'positive')),
  add column if not exists ai_urgent boolean,
  add column if not exists ai_note text check (char_length(ai_note) <= 300),
  add column if not exists ai_at timestamptz;

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  business_id bigint references public.businesses (id) on delete set null,
  kind text not null check (kind in ('classify', 'digest')),
  model text not null,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_created_idx on public.ai_usage (created_at);

create table if not exists public.ai_digests (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  week_start date not null,
  text text not null check (char_length(text) <= 3000),
  created_at timestamptz not null default now(),
  unique (business_id, week_start)
);

alter table public.ai_usage enable row level security;
alter table public.ai_digests enable row level security;
revoke all on public.ai_usage, public.ai_digests from anon, authenticated;
grant select, insert, update, delete on public.ai_usage, public.ai_digests to service_role;

commit;
