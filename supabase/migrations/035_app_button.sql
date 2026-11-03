-- TapReview: migration 035 — кнопка «Отзыв в Telegram» на странице карты /c/КОД
--   businesses.app_button — показывать гостю кнопку, которая открывает Mini App на странице заведения
--   с билетом карты (отзыв получит метку «по карте TapReview»). По умолчанию выключено, включается в админке.
--   Кнопка видна, только если заведение ещё и в каталоге (catalog_visible, миграция 034).
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/035_app_button.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists app_button boolean not null default false;

commit;
