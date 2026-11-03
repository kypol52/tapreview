-- TapReview: migration 037 — сообщения гостю о его отзывах (бот Mini App)
--   app_users.notify    — гость сам включил «Сообщать о моих отзывах» (и разрешил боту писать ему в Telegram);
--   app_users.notify_at — когда включил (согласие). Выключить можно в профиле; если гость заблокировал бота,
--                         сервер выключает сам. Сообщения: отзыв опубликован / не прошёл проверку / заведение ответило.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/037_app_notify.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.app_users
  add column if not exists notify boolean not null default false,
  add column if not exists notify_at timestamptz;

commit;
