-- TapReview: migration 032 — уровни гостей: Новый → Постоянный (3+ визита) → VIP (businesses.vip_visits+)
--   Визиты — те же обезличенные визиты по cookie (guest_visits, миграция 028), новых данных о гостях нет.
--   businesses.vip_visits — с какого визита гость VIP (4–100), vip_gift — подарок VIP-гостя (вместо колеса).
--   bonus_codes.vip — код выдан VIP-гостю (кассир видит значок ⭐ VIP).
--   guest_levels(ids, vip, since) — сколько гостей на каждом уровне среди тех, кто был с даты since.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/032_vip_levels.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists vip_visits smallint check (vip_visits between 4 and 100),
  add column if not exists vip_gift text check (char_length(vip_gift) <= 60);

alter table public.bonus_codes
  add column if not exists vip boolean not null default false;

create or replace function public.guest_levels(p_ids bigint[], p_vip integer, p_since date)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  with g as (
    select v.business_id, v.visitor_key, count(*) as visits
    from public.guest_visits v
    where v.business_id = any (p_ids)
    group by v.business_id, v.visitor_key
    having max(v.day) >= p_since
  )
  select jsonb_build_object(
    'new', count(*) filter (where visits < 3),
    'regular', count(*) filter (where visits >= 3 and (p_vip is null or visits < p_vip)),
    'vip', count(*) filter (where p_vip is not null and visits >= p_vip)
  )
  from g;
$fn$;

revoke all on function public.guest_levels(bigint[], integer, date) from public, anon, authenticated;
grant execute on function public.guest_levels(bigint[], integer, date) to service_role;

commit;
