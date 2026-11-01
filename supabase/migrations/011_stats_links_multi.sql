-- TapReview: migration 011 (one statistics link for several businesses)
-- 1) stats_links.business_ids: all businesses the link shows, in order.
--    business_id stays = the first of them (the link is deleted together with it).
-- 2) stats_daily: events by day for several businesses, optionally for one card only.
-- Safe to run several times.

begin;

-- 1. Several businesses per link
alter table public.stats_links
  add column if not exists business_ids bigint[] not null default '{}';

update public.stats_links
  set business_ids = array[business_id]
  where cardinality(business_ids) = 0;

alter table public.stats_links
  drop constraint if exists stats_links_business_ids_check;
alter table public.stats_links
  add constraint stats_links_business_ids_check check (cardinality(business_ids) <= 50);

create index if not exists stats_links_business_ids_idx
  on public.stats_links using gin (business_ids);

-- 2. Statistics by day (Moscow days) for the chart
create or replace function public.stats_daily(
  p_business_ids bigint[],
  p_card_id bigint,
  p_from timestamptz,
  p_tz text default 'Europe/Moscow'
)
returns table (
  day date,
  event_type text,
  events bigint
)
language sql
stable
set search_path = ''
as $fn$
  select
    (e.created_at at time zone p_tz)::date,
    e.event_type,
    count(*)
  from public.click_events e
  where e.business_id = any (p_business_ids)
    and (p_card_id is null or e.card_id = p_card_id)
    and e.created_at >= p_from
  group by 1, 2
  order by 1;
$fn$;

revoke all on function public.stats_daily(bigint[], bigint, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.stats_daily(bigint[], bigint, timestamptz, text)
  to service_role;

commit;
