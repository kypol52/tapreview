-- TapReview: migration 025 — блок «Сейчас у нас» (новость, событие, акция) на странице заведения
--   businesses.moment: { "title", "text", "photo": <media id>, "url", "button", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
--   Показывается гостю после оценки (4–5, «сразу на картах», после сообщения владельцу) в даты from..to (МСК, включительно).
--   media.kind += 'moment' — фото для блока.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/025_moment.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists moment jsonb not null default '{}'::jsonb;

alter table public.media
  drop constraint if exists media_kind_check;
alter table public.media
  add constraint media_kind_check check (kind in ('bg', 'logo', 'moment'));

commit;
