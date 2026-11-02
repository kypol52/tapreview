-- TapReview: migration 026 — панель «Здоровье» в админке (GET /api/admin/health)
-- Одна функция собирает по каждому заведению сигналы за последние дни:
--   последнее открытие страницы, открытия и переходы за 7 дней и за 7 дней до них,
--   неразобранные сообщения гостей (1–3 ★) за 30 дней, подключённые Telegram-чаты,
--   когда владелец последний раз открывал статистику, подарки за 30 дней (выдано / погашено).
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/026_admin_health.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

create or replace function public.admin_health()
returns table (
  business_id bigint,
  last_view_at timestamptz,
  views_7d bigint,
  views_prev_7d bigint,
  clicks_7d bigint,
  open_feedback bigint,
  tg_chats bigint,
  stats_opened_at timestamptz,
  bonus_issued_30d bigint,
  bonus_redeemed_30d bigint
)
language sql
stable
set search_path = ''
as $fn$
  select
    b.id,
    (select max(e.created_at) from public.click_events e
      where e.business_id = b.id and e.event_type = 'page_view'),
    (select count(*) from public.click_events e
      where e.business_id = b.id and e.event_type = 'page_view' and e.created_at >= now() - interval '7 days'),
    (select count(*) from public.click_events e
      where e.business_id = b.id and e.event_type = 'page_view'
        and e.created_at >= now() - interval '14 days' and e.created_at < now() - interval '7 days'),
    (select count(*) from public.click_events e
      where e.business_id = b.id and e.event_type = 'click' and e.created_at >= now() - interval '7 days'),
    (select count(*) from public.feedback f
      where f.business_id = b.id and f.resolved_at is null and f.created_at >= now() - interval '30 days'),
    (select count(*) from public.tg_subscribers t where t.business_id = b.id),
    (select max(s.last_opened_at) from public.stats_links s
      where s.business_id = b.id or b.id = any (s.business_ids)),
    (select count(*) from public.bonus_codes c
      where c.business_id = b.id and c.created_at >= now() - interval '30 days'),
    (select count(*) from public.bonus_codes c
      where c.business_id = b.id and c.created_at >= now() - interval '30 days' and c.redeemed_at is not null)
  from public.businesses b
  where b.is_active;
$fn$;

revoke all on function public.admin_health() from public, anon, authenticated;
grant execute on function public.admin_health() to service_role;

commit;
