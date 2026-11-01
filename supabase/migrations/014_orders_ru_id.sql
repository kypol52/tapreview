-- TapReview: migration 014 (orders are first saved in Russia)
-- The order form sends data to a Yandex Cloud function that saves it in Yandex Database (Russia)
-- and then relays a copy here. ru_id = id of the order in the Russian database,
-- used to delete it there too when the order is deleted in the admin panel.
-- Safe to run several times.

begin;

alter table public.orders
  add column if not exists ru_id text;

create unique index if not exists orders_ru_id_key
  on public.orders (ru_id);

commit;
