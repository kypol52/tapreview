-- TapReview: migration 047 — меню и заказ со стола
--   menu_items    — меню заведения: раздел, название, цена (₽, пусто — «по запросу»), описание, фото (media), «рекомендуем»,
--                   «в наличии», порядок. Вносится списком текста (src/menu.js parseMenu), фото и описание — по желанию.
--   table_orders  — заказ гостя со стола (модуль «Сервис в зале»): позиции с ценами на момент заказа, сумма, комментарий,
--                   статус как у вызовов. Без оплаты — оплата официанту как обычно. visitor_hash — обезличенный ключ
--                   устройства (защита от шуток), хранится 180 дней.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/047_menu.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

create table if not exists public.menu_items (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  section text not null default '' check (char_length(section) <= 40),
  name text not null check (char_length(name) between 1 and 80),
  price integer check (price between 0 and 1000000),
  description text check (char_length(description) <= 200),
  photo text check (photo ~ '^[0-9a-f-]{36}$'),
  recommended boolean not null default false,
  available boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists menu_items_business_idx on public.menu_items (business_id, position);

create table if not exists public.table_orders (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  card_id bigint references public.cards (id) on delete set null,
  place text not null check (char_length(place) between 1 and 60),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 30),
  total integer not null check (total >= 0),
  comment text check (char_length(comment) <= 200),
  upsell integer not null default 0 check (upsell >= 0),
  status text not null default 'new' check (status in ('new', 'accepted', 'done')),
  visitor_hash text,
  accepted_by text check (char_length(accepted_by) <= 80),
  accepted_staff_id bigint references public.staff (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  done_at timestamptz
);
create index if not exists table_orders_business_idx on public.table_orders (business_id, created_at desc);
create index if not exists table_orders_active_idx on public.table_orders (business_id) where status <> 'done';
create index if not exists table_orders_card_idx on public.table_orders (card_id, created_at desc);

alter table public.menu_items enable row level security;
alter table public.table_orders enable row level security;
revoke all on public.menu_items, public.table_orders from anon, authenticated;
grant select, insert, update, delete on public.menu_items, public.table_orders to service_role;

commit;
