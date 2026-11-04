-- TapReview: migration 042 — модуль «Сервис в зале»: вызов сотрудника со стола
--   businesses.modules       — модули сверх тарифа (src/tariffs.js MODULES); пока только 'service'
--   cards.is_table           — карта лежит на столе: гость видит кнопки «Позвать официанта», «Попросить счёт», «Нужна помощь».
--                              Название стола — существующее поле cards.label («Стол 5»)
--   tg_subscribers.service_calls — этот чат получает вызовы гостей (галочка в админке)
--   service_calls            — вызовы: стол, что нужно, сколько счетов, статус, кто и когда принял.
--                              visitor_hash — тот же обезличенный ключ устройства, что у визитов (guests.js), только для
--                              защиты от повторных нажатий; хранится 180 дней (ежедневная очистка в src/service.js)
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/042_service_calls.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists modules text[] not null default '{}';
alter table public.businesses drop constraint if exists businesses_modules_check;
alter table public.businesses
  add constraint businesses_modules_check check (modules <@ array['service']::text[]);

alter table public.cards
  add column if not exists is_table boolean not null default false;

alter table public.tg_subscribers
  add column if not exists service_calls boolean not null default false;

create table if not exists public.service_calls (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  card_id bigint references public.cards (id) on delete set null,
  place text not null check (char_length(place) between 1 and 60),
  kind text not null check (kind in ('waiter', 'bill', 'help')),
  split smallint check (split between 1 and 10),
  status text not null default 'new' check (status in ('new', 'accepted', 'done')),
  visitor_hash text,
  accepted_by text check (char_length(accepted_by) <= 80),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  done_at timestamptz
);
create index if not exists service_calls_business_created_idx on public.service_calls (business_id, created_at desc);
create index if not exists service_calls_active_idx on public.service_calls (business_id) where status <> 'done';
create index if not exists service_calls_card_idx on public.service_calls (card_id, kind, created_at desc);

alter table public.service_calls enable row level security;
revoke all on public.service_calls from anon, authenticated;
grant select, insert, update, delete on public.service_calls to service_role;

commit;
