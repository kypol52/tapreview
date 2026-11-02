-- TapReview: migration 027 — вкладка «Настройки» на странице статистики (/s/:token/settings)
--   stats_links.can_edit — по этой ссылке можно менять «Сейчас у нас», подарки и ссылки «Ещё у нас».
--   По умолчанию выключено: галочку ставит администратор в админке у нужной ссылки (владельцу — да, управляющему — по желанию).
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/027_owner_settings.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.stats_links
  add column if not exists can_edit boolean not null default false;

commit;
