-- TapReview: migration 022 (own design of the review page per venue)
-- businesses.theme = 'custom' + businesses.design:
--   { "bg": <media id>, "logo": <media id>, "dim": 30..85, "glow": true|false }
--   bg   — background photo of the venue (under a dark veil so the text stays readable)
--   logo — logo picture instead of the name (light logo with a neon glow when glow = true)
-- media — pictures uploaded in the admin panel (already compressed in the browser, ≤ 700 KB),
--   served by the site at /m/<id> with a long browser cache. Stored in the database in Russia.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/022_custom_design.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists design jsonb not null default '{}'::jsonb;

alter table public.businesses
  drop constraint if exists businesses_theme_check;
alter table public.businesses
  add constraint businesses_theme_check check (theme in ('classic', 'dark', 'coffee', 'fresh', 'rose', 'custom'));

create table if not exists public.media (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('bg', 'logo')),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data text not null check (char_length(data) <= 1000000),
  created_at timestamptz not null default now()
);

alter table public.media enable row level security;
grant select, insert, delete on public.media to service_role;

commit;
