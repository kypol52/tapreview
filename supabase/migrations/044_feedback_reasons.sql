-- TapReview: migration 044 — разбор недовольных гостей
--   feedback.reasons     — причины одним касанием: wait (долго ждали), quality (еда и напитки / результат услуги / товар),
--                          service (обслуживание), clean (чистота), price (цена), other (другое). Можно несколько.
--   feedback.text        — теперь необязателен, если отмечена хоть одна причина
--   feedback.reminded_at — когда бот напомнил владельцу о неразобранном сообщении (один раз, через 2 часа, не ночью)
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/044_feedback_reasons.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.feedback
  add column if not exists reasons text[] not null default '{}',
  add column if not exists reminded_at timestamptz;

alter table public.feedback drop constraint if exists feedback_reasons_check;
alter table public.feedback
  add constraint feedback_reasons_check check (reasons <@ array['wait', 'quality', 'service', 'clean', 'price', 'other']::text[]);

-- Было: текст от 1 до 1000 символов. Стало: до 1000, и пустой — только если есть причина
alter table public.feedback drop constraint if exists feedback_text_check;
alter table public.feedback
  add constraint feedback_text_check check (char_length(text) <= 1000 and (char_length(text) >= 1 or cardinality(reasons) > 0));

create index if not exists feedback_open_idx on public.feedback (created_at) where resolved_at is null and reminded_at is null;

commit;
