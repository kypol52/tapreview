-- TapReview: migration 003
-- Gives the server (secret key = service_role) access to our tables.
-- The browser (anon, authenticated) keeps its limited rights from migration 001.
-- Safe to run several times.

grant usage on schema public to service_role;

grant select, insert, update, delete
  on public.businesses to service_role;

grant select, insert, update, delete
  on public.click_events to service_role;

grant usage, select
  on all sequences in schema public to service_role;
