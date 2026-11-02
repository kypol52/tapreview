-- TapReview: migration 033 — тарифы «Старт» / «Стандарт» / «Плюс» и «Свой дизайн» за 990 ₽
--   businesses.tariff: start    — страница сразу с кнопками площадок, статистика, отчёт в Telegram;
--                      standard — + оценка гостя и сообщения недовольных, «Ещё у нас», «Сейчас у нас», Score, итоги месяца;
--                      plus     — + подарки (колесо, штампы, VIP, «Подарите другу», касса персонала), управление из Telegram.
--   Уже подключённые заведения получают «Плюс», чтобы у них ничего не пропало; новые по умолчанию — «Стандарт».
--   orders.tariff, orders.custom_design — что выбрали в калькуляторе.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/033_tariffs.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists tariff text not null default 'plus' check (tariff in ('start', 'standard', 'plus'));
alter table public.businesses
  alter column tariff set default 'standard';

alter table public.orders
  add column if not exists tariff text not null default 'standard' check (tariff in ('start', 'standard', 'plus')),
  add column if not exists custom_design boolean not null default false;

commit;
