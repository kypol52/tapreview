-- TapReview: migration 023 (guest gift: protection from abuse)
-- 1) businesses.bonus_daily_limit — max gift codes per venue per day (Moscow time), default 50.
--    After the limit the guest sees «Подарки на сегодня закончились — приходите завтра».
-- 2) bonus_codes.device_day — salted hash of "network + browser" that changes every day
--    (the same daily fingerprint as in the stats; no IP address is stored).
--    One code per phone per day even in private mode / after clearing cookies.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/023_bonus_limits.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists bonus_daily_limit integer not null default 50;
alter table public.businesses
  drop constraint if exists businesses_bonus_daily_limit_check;
alter table public.businesses
  add constraint businesses_bonus_daily_limit_check check (bonus_daily_limit between 1 and 10000);

alter table public.bonus_codes
  add column if not exists device_day text;
create index if not exists bonus_codes_device_day_idx on public.bonus_codes (business_id, device_day);

commit;
