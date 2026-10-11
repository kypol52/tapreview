-- TapReview: migration 005
-- Adds "tagline": the line under the business name on the public page,
-- e.g. "Ресторан • Москва". Free text, set per business in the admin panel.
-- Safe to run several times.

alter table public.businesses
  add column if not exists tagline text;

alter table public.businesses
  drop constraint if exists businesses_tagline_length;
alter table public.businesses
  add constraint businesses_tagline_length
  check (char_length(tagline) <= 80);
