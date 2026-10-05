-- TapReview: migration 004 (analytics)
-- 1) dedupe_key: protects statistics from repeated counting
-- 2) functions that the admin panel uses to build reports
-- Safe to run several times.

begin;

-- 1. Duplicate protection
alter table public.click_events
  add column if not exists dedupe_key text;

create unique index if not exists click_events_dedupe_key_idx
  on public.click_events (dedupe_key);

create index if not exists click_events_created_idx
  on public.click_events (created_at desc);

-- 2. Statistics of one business by day
create or replace function public.business_stats(
  p_business_id bigint,
  p_days integer default 30,
  p_tz text default 'Europe/Moscow'
)
returns table (
  day date,
  event_type text,
  destination text,
  source text,
  events bigint
)
language sql
stable
set search_path = ''
as $fn$
  select
    (e.created_at at time zone p_tz)::date,
    e.event_type,
    e.destination,
    e.source,
    count(*)
  from public.click_events e
  where e.business_id = p_business_id
    and e.created_at >= now()
      - make_interval(days => greatest(1, least(p_days, 365)))
  group by 1, 2, 3, 4
  order by 1;
$fn$;

-- 3. Totals of all businesses (for the list in the admin panel)
create or replace function public.stats_summary(
  p_days integer default 30
)
returns table (
  business_id bigint,
  page_views bigint,
  clicks bigint
)
language sql
stable
set search_path = ''
as $fn$
  select
    e.business_id,
    count(*) filter (where e.event_type = 'page_view'),
    count(*) filter (where e.event_type = 'click')
  from public.click_events e
  where e.created_at >= now()
    - make_interval(days => greatest(1, least(p_days, 365)))
  group by e.business_id;
$fn$;

-- 4. Only the server may call these functions
revoke all on function public.business_stats(bigint, integer, text)
  from public, anon, authenticated;
revoke all on function public.stats_summary(integer)
  from public, anon, authenticated;

grant execute on function public.business_stats(bigint, integer, text)
  to service_role;
grant execute on function public.stats_summary(integer)
  to service_role;

commit;
