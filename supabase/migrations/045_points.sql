-- TapReview: migration 045 — баллы лояльности (тариф «Плюс»)
--   businesses.points_*   — включены ли баллы и правила: % от чека, сколько чека можно оплатить баллами, через сколько дней
--                           без операций баллы сгорают, самый большой чек (защита от ошибок и накруток)
--   point_codes           — одноразовый код гостя для кассы (6 цифр, 10 минут): гость показывает его кассиру
--   point_ops             — журнал: начисление (+), списание (−), сгорание (−). Баланс = сумма points.
--                           visitor_key — тот же обезличенный ключ устройства, что у визитов и штампов (guests.js)
--   points_expire()       — раз в день: баллы гостя сгорают, если по ним не было операций points_expire_days дней
-- 1 балл = 1 ₽ скидки. Деньги через TapReview не идут: скидку кассир проводит в своей кассе.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/045_points.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists points_on boolean not null default false,
  add column if not exists points_percent smallint not null default 5,
  add column if not exists points_max_share smallint not null default 30,
  add column if not exists points_expire_days smallint not null default 180,
  add column if not exists points_max_check integer not null default 50000;

alter table public.businesses drop constraint if exists businesses_points_check;
alter table public.businesses
  add constraint businesses_points_check check (
    points_percent between 1 and 30 and points_max_share between 1 and 100
    and points_expire_days between 30 and 730 and points_max_check between 100 and 10000000
  );

create table if not exists public.point_codes (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  visitor_key text not null,
  code text not null check (code ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz
);
create index if not exists point_codes_lookup_idx on public.point_codes (business_id, code, expires_at desc);
create index if not exists point_codes_visitor_idx on public.point_codes (business_id, visitor_key, expires_at desc);

create table if not exists public.point_ops (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  visitor_key text not null,
  kind text not null check (kind in ('earn', 'spend', 'expire')),
  points integer not null check (points <> 0),
  check_sum integer check (check_sum >= 0),
  by_label text check (char_length(by_label) <= 80),
  staff_id bigint references public.staff (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists point_ops_visitor_idx on public.point_ops (business_id, visitor_key, created_at);
create index if not exists point_ops_business_idx on public.point_ops (business_id, created_at);

create or replace function public.points_expire() returns integer
language sql
as $$
  with due as (
    select o.business_id, o.visitor_key, sum(o.points) as balance
    from public.point_ops o
    join public.businesses b on b.id = o.business_id
    group by o.business_id, o.visitor_key, b.points_expire_days
    having sum(o.points) > 0 and max(o.created_at) < now() - make_interval(days => b.points_expire_days)
  ), ins as (
    insert into public.point_ops (business_id, visitor_key, kind, points)
    select business_id, visitor_key, 'expire', -balance from due
    returning 1
  )
  select count(*)::integer from ins;
$$;

alter table public.point_codes enable row level security;
alter table public.point_ops enable row level security;
revoke all on public.point_codes, public.point_ops from anon, authenticated;
grant select, insert, update, delete on public.point_codes, public.point_ops to service_role;
revoke all on function public.points_expire() from public;
grant execute on function public.points_expire() to service_role;

commit;
