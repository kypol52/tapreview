-- TapReview: migration 040 — заведение само включает каталог Mini App (кабинет владельца)
--   catalog_consent_at — когда представитель заведения дал согласие на публичные рейтинг и отзывы;
--   catalog_consent_by — кто (пользователь Mini App, app_users.id; его Telegram подключён к боту владельцев с правом управления).
--   Админ по-прежнему может включить каталог сам (согласие получено устно/в договоре) — тогда эти поля пустые.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/040_catalog_consent.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists catalog_consent_at timestamptz,
  add column if not exists catalog_consent_by bigint references public.app_users (id) on delete set null;

commit;
