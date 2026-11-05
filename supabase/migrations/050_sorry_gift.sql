-- TapReview: migration 050 — подарок-извинение при оценке 1–3
--   businesses.sorry_gift — что получает недовольный гость (например, «Десерт в подарок»). Пусто — как раньше:
--     обычный подарок (колесо) появляется позже, под формой сообщения владельцу.
--     Заполнено — при оценке 1–3 одноразовый код выдаётся сразу и показывается над формой, без колеса.
--   bonus_codes.sorry — код выдан как извинение (для статистики и кассы)
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/050_sorry_gift.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists sorry_gift text;

alter table public.businesses drop constraint if exists businesses_sorry_gift_check;
alter table public.businesses add constraint businesses_sorry_gift_check check (sorry_gift is null or char_length(sorry_gift) between 1 and 60);

alter table public.bonus_codes
  add column if not exists sorry boolean not null default false;

commit;
