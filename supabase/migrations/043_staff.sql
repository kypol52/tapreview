-- TapReview: migration 043 — сотрудники и их оценки (модуль «Сервис в зале»)
--   staff                        — сотрудники заведения: имя, работает ли, своя ссылка на чаевые (необязательно).
--                                  Уволенного не удаляем, а выключаем — его статистика остаётся у владельца.
--   cards.staff_id               — личная карта сотрудника: оценки и сообщения с неё — его
--   staff_links.staff_id         — чья ссылка персонала: «Принял» на странице вызовов засчитывается этому сотруднику
--   ratings.staff_id, feedback.staff_id, service_calls.accepted_staff_id — к кому относится
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/043_staff.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

create table if not exists public.staff (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  is_active boolean not null default true,
  tips_url text check (tips_url is null or (tips_url ~ '^https://' and char_length(tips_url) <= 2000)),
  created_at timestamptz not null default now()
);
create index if not exists staff_business_idx on public.staff (business_id);

alter table public.cards add column if not exists staff_id bigint references public.staff (id) on delete set null;
alter table public.staff_links add column if not exists staff_id bigint references public.staff (id) on delete set null;
alter table public.ratings add column if not exists staff_id bigint references public.staff (id) on delete set null;
alter table public.feedback add column if not exists staff_id bigint references public.staff (id) on delete set null;
alter table public.service_calls add column if not exists accepted_staff_id bigint references public.staff (id) on delete set null;

create index if not exists ratings_staff_idx on public.ratings (staff_id, created_at) where staff_id is not null;
create index if not exists feedback_staff_idx on public.feedback (staff_id, created_at) where staff_id is not null;
create index if not exists service_calls_staff_idx on public.service_calls (accepted_staff_id, created_at) where accepted_staff_id is not null;

alter table public.staff enable row level security;
revoke all on public.staff from anon, authenticated;
grant select, insert, update, delete on public.staff to service_role;

commit;
