-- TapReview: migration 029 — «Итоги месяца» (Wrapped) для владельца: /s/:token/wrapped?m=YYYY-MM
--   wrapped_month(ids, from, to) — все цифры месяца одним запросом (jsonb):
--     открытия, переходы по площадкам, дни недели и часы (МСК), лучший день, оценки и «что понравилось»,
--     сообщения недовольных гостей (сколько разобрано), подарки, гости и вернувшиеся гости.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/029_wrapped.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

create or replace function public.wrapped_month(p_ids bigint[], p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  with ev as (
    select e.event_type, e.destination, e.created_at at time zone 'Europe/Moscow' as local
    from public.click_events e
    where e.business_id = any (p_ids) and e.created_at >= p_from and e.created_at < p_to
  ),
  rt as (
    select r.score, r.likes from public.ratings r
    where r.business_id = any (p_ids) and r.created_at >= p_from and r.created_at < p_to
  ),
  gv as (
    select v.business_id, v.visitor_key, count(*) as days,
      exists (
        select 1 from public.guest_visits p
        where p.business_id = v.business_id and p.visitor_key = v.visitor_key
          and p.day < (p_from at time zone 'Europe/Moscow')::date
      ) as before
    from public.guest_visits v
    where v.business_id = any (p_ids)
      and v.day >= (p_from at time zone 'Europe/Moscow')::date
      and v.day < (p_to at time zone 'Europe/Moscow')::date
    group by v.business_id, v.visitor_key
  )
  select jsonb_build_object(
    'views', (select count(*) from ev where event_type = 'page_view'),
    'clicks', (select coalesce(jsonb_object_agg(destination, n), '{}'::jsonb)
      from (select destination, count(*) as n from ev where event_type = 'click' group by destination) x),
    'weekday', (select coalesce(jsonb_object_agg(d, n), '{}'::jsonb)
      from (select extract(isodow from local)::int as d, count(*) as n from ev where event_type = 'page_view' group by 1) x),
    'hour', (select coalesce(jsonb_object_agg(h, n), '{}'::jsonb)
      from (select extract(hour from local)::int as h, count(*) as n from ev where event_type = 'page_view' group by 1) x),
    'best_day', (select jsonb_build_object('day', d, 'views', n)
      from (select local::date as d, count(*) as n from ev where event_type = 'page_view' group by 1 order by 2 desc, 1 limit 1) x),
    'ratings', (select jsonb_build_object('count', count(*), 'avg', avg(score), 'low', count(*) filter (where score <= 3)) from rt),
    'likes', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select unnest(likes) as k, count(*) as n from rt group by 1) x),
    'liked', (select count(*) from rt where cardinality(likes) > 0),
    'feedback', (select jsonb_build_object('count', count(*), 'resolved', count(*) filter (where f.resolved_at is not null))
      from public.feedback f where f.business_id = any (p_ids) and f.created_at >= p_from and f.created_at < p_to),
    'bonus', (select jsonb_build_object('issued', count(*), 'redeemed', count(*) filter (where c.redeemed_at is not null),
        'rewards', count(*) filter (where c.stamp_reward))
      from public.bonus_codes c where c.business_id = any (p_ids) and c.created_at >= p_from and c.created_at < p_to),
    'guests', (select jsonb_build_object('guests', count(*), 'returning', count(*) filter (where days > 1 or before)) from gv)
  );
$fn$;

revoke all on function public.wrapped_month(bigint[], timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.wrapped_month(bigint[], timestamptz, timestamptz) to service_role;

commit;
