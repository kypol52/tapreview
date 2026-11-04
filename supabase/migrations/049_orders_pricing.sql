-- TapReview: migration 049 — заявки под новый прайс (4 ноября 2026: подписка за заведение, Start / Business / Pro)
--   orders.modules — модули к тарифу Business: service (Сервис в зале), ai (AI-разбор отзывов)
--   orders.early   — заявка на условия Early Partner (первые 20 заведений)
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/049_orders_pricing.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.orders
  add column if not exists modules text[] not null default '{}',
  add column if not exists early boolean not null default false;

alter table public.orders drop constraint if exists orders_modules_check;
alter table public.orders add constraint orders_modules_check check (modules <@ array['service', 'ai']::text[]);

commit;
