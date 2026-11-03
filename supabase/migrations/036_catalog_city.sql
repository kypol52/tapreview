-- TapReview: migration 036 — фильтр каталога Mini App по городу
--   app_catalog(..., p_city) — только заведения этого города (без учёта регистра и пробелов по краям).
--   Старые вызовы без p_city работают как раньше (все города), поэтому миграцию можно применять до загрузки кода.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/036_catalog_city.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

drop function if exists public.app_catalog(text, text, numeric, integer, text, integer, integer);

create or replace function public.app_catalog(
  p_q text default null,
  p_category text default null,
  p_min_score numeric default null,
  p_min_reviews integer default 0,
  p_sort text default 'top',
  p_limit integer default 20,
  p_offset integer default 0,
  p_city text default null
)
returns table (
  id bigint,
  slug text,
  name text,
  category text,
  city text,
  address text,
  tagline text,
  logo_url text,
  design jsonb,
  cover uuid,
  reviews bigint,
  avg_score numeric,
  views_30d bigint,
  catalog_since timestamptz
)
language sql
stable
set search_path = ''
as $fn$
  with base as (
    select
      b.id, b.slug, b.name, b.category, b.city, b.address, b.tagline, b.logo_url, b.design,
      b.photos[1] as cover,
      coalesce(r.cnt, 0) as reviews,
      r.avg as avg_score,
      coalesce(v.cnt, 0) as views_30d,
      coalesce(b.catalog_since, b.created_at) as catalog_since
    from public.businesses b
    left join lateral (
      select count(*) as cnt, round(avg(x.score)::numeric, 1) as avg
      from public.reviews x
      where x.business_id = b.id and x.status = 'published'
    ) r on true
    left join lateral (
      select count(*) as cnt
      from public.click_events e
      where e.business_id = b.id and e.event_type = 'page_view' and e.created_at >= now() - interval '30 days'
    ) v on true
    where b.is_active and b.catalog_visible
      and (p_city is null or btrim(p_city) = '' or lower(btrim(coalesce(b.city, ''))) = lower(btrim(p_city)))
      and (p_category is null or b.category = p_category
           or (p_category = 'other' and b.category not in ('restaurant', 'beauty', 'barber', 'shop')))
      and (p_q is null or p_q = ''
           or strpos(lower(b.name), lower(p_q)) > 0
           or strpos(lower(coalesce(b.address, '')), lower(p_q)) > 0
           or strpos(lower(coalesce(b.city, '')), lower(p_q)) > 0
           or strpos(lower(coalesce(b.tagline, '')), lower(p_q)) > 0)
  )
  select * from base
  where (p_min_score is null or base.avg_score >= p_min_score)
    and base.reviews >= greatest(coalesce(p_min_reviews, 0), 0)
  order by
    case when p_sort = 'top' then base.avg_score end desc nulls last,
    case when p_sort = 'top' then base.reviews end desc,
    case when p_sort = 'popular' then base.views_30d end desc,
    case when p_sort = 'new' then base.catalog_since end desc,
    base.name asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$fn$;

revoke all on function public.app_catalog(text, text, numeric, integer, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.app_catalog(text, text, numeric, integer, text, integer, integer, text) to service_role;

commit;
