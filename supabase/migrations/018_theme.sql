-- TapReview: migration 018 (review page theme per business)
-- businesses.theme — ready-made look of the review page, chosen in the admin panel in one click:
--   classic (light, default) | dark | coffee | fresh | rose
-- brand_color (line under the name) keeps working on top of any theme.
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists theme text not null default 'classic';

alter table public.businesses
  drop constraint if exists businesses_theme_check;
alter table public.businesses
  add constraint businesses_theme_check check (theme in ('classic', 'dark', 'coffee', 'fresh', 'rose'));

commit;
