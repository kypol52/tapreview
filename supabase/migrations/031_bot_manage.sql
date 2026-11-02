-- TapReview: migration 031 — управление заведением из Telegram-бота
--   tg_subscribers.can_manage — этот чат может включать/выключать подарки и публиковать «Сейчас у нас»
--     (/manage, /gifts_on, /gifts_off, /news, /news_off). По умолчанию выключено — галочку ставит администратор.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/031_bot_manage.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.tg_subscribers
  add column if not exists can_manage boolean not null default false;

commit;
