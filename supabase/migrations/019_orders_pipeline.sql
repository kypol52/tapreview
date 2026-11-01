-- TapReview: migration 019 (simple sales pipeline in "Заявки")
-- Stages: new → in_work (связались) → meeting (встреча) → pilot (пилот) → done (оплатил) / rejected (отказ)
-- next_step + next_at — what to do and when; on that day a reminder comes to Telegram at 09:00 MSK
-- (only order numbers, no personal data). note — free notes. source: site (form) | manual (added in admin).
-- Run on the server: sudo -u postgres psql -d tapreview -f /opt/tapreview/site/supabase/migrations/019_orders_pipeline.sql
-- Safe to run several times.

begin;

alter table public.orders
  add column if not exists next_step text,
  add column if not exists next_at date,
  add column if not exists note text,
  add column if not exists source text not null default 'site',
  add column if not exists reminded_on date;

-- Contacts added by hand (personal meeting) have no website consent checkbox
alter table public.orders alter column consent_at drop not null;
alter table public.orders alter column consent_version drop not null;

alter table public.orders
  drop constraint if exists orders_checks;
alter table public.orders
  add constraint orders_checks check (
    status in ('new', 'in_work', 'meeting', 'pilot', 'done', 'rejected')
    and source in ('site', 'manual')
    and plan in ('month', 'year')
    and venues between 1 and 50
    and cards between 1 and 500
    and cards >= venues
    and char_length(name) between 1 and 80
    and char_length(coalesce(phone, '')) <= 30
    and char_length(coalesce(telegram, '')) <= 40
    and (coalesce(phone, '') <> '' or coalesce(telegram, '') <> '')
    and char_length(business_name) between 1 and 120
    and char_length(coalesce(city, '')) <= 80
    and char_length(coalesce(comment, '')) <= 1000
    and char_length(coalesce(consent_version, '')) <= 40
    and char_length(coalesce(next_step, '')) <= 200
    and char_length(coalesce(note, '')) <= 4000
  );

create index if not exists orders_next_at_idx on public.orders (next_at) where next_at is not null;

commit;
