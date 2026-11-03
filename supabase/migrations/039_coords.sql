-- TapReview: migration 039 — координаты заведения для «Рядом со мной» в Mini App
--   businesses.lat / lon — широта и долгота (вносятся в админке: ссылка Яндекс Карт / 2ГИС или цифры).
--   Геопозиция гостя на сервер не передаётся: расстояние считает приложение на телефоне.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/039_coords.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists lat double precision,
  add column if not exists lon double precision;

alter table public.businesses
  drop constraint if exists businesses_coords_check;
alter table public.businesses
  add constraint businesses_coords_check check (
    (lat is null and lon is null)
    or (lat is not null and lon is not null and lat between -90 and 90 and lon between -180 and 180)
  );

commit;
