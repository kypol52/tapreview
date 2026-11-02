-- TapReview: migration 028 — «С возвращением!» и штампы
--   guest_visits — визиты гостя в заведение: не чаще одного в день, только при касании карты или QR.
--     visitor_key — хеш случайного номера устройства из cookie tr_device + заведение + секрет (номер и IP не хранятся).
--     Хранится 400 дней (чистка по расписанию на сервере).
--   log_visit(business_id, key) — отметить визит сегодня (МСК) и вернуть, который это визит по счёту.
--   Штампы: штамп = код подарка, погашенный на кассе. Набрал businesses.stamps_goal штампов —
--     следующий подарок будет businesses.stamps_prize (bonus_codes.stamp_reward = true), счёт начинается заново.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/028_guest_visits_stamps.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

create table if not exists public.guest_visits (
  business_id bigint not null references public.businesses (id) on delete cascade,
  visitor_key text not null,
  day date not null,
  primary key (business_id, visitor_key, day)
);
create index if not exists guest_visits_day_idx on public.guest_visits (day);

alter table public.guest_visits enable row level security;
grant select, insert, delete on public.guest_visits to service_role;

create or replace function public.log_visit(p_business_id bigint, p_key text)
returns integer
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  visits integer;
begin
  insert into public.guest_visits (business_id, visitor_key, day)
  values (p_business_id, p_key, (now() at time zone 'Europe/Moscow')::date)
  on conflict do nothing;
  select count(*) into visits from public.guest_visits
  where business_id = p_business_id and visitor_key = p_key;
  return visits;
end;
$fn$;

revoke all on function public.log_visit(bigint, text) from public, anon, authenticated;
grant execute on function public.log_visit(bigint, text) to service_role;

alter table public.businesses
  add column if not exists stamps_goal smallint check (stamps_goal between 2 and 10),
  add column if not exists stamps_prize text check (char_length(stamps_prize) <= 60);

alter table public.bonus_codes
  add column if not exists stamp_reward boolean not null default false;

create index if not exists bonus_codes_visitor_idx on public.bonus_codes (business_id, visitor_key, created_at desc);

commit;
