-- TapReview: migration 024
--   ratings.likes          — «Что понравилось?» после оценки 4–5 (кухня, обслуживание, атмосфера, напитки, цены)
--   feedback.phone         — телефон гостя при оценке 1–3, только по его желанию и с согласием (хранится 30 дней)
--   feedback.phone_consent_at — когда гость дал согласие
--   feedback.resolved_at   — владелец отметил сообщение «Разобрано» в статистике
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/024_feedback_phone_likes.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.ratings
  add column if not exists likes text[] not null default '{}';

alter table public.feedback
  add column if not exists phone text check (phone ~ '^\+7[0-9]{10}$'),
  add column if not exists phone_consent_at timestamptz,
  add column if not exists resolved_at timestamptz;

create index if not exists feedback_phone_created_idx on public.feedback (created_at) where phone is not null;

commit;
