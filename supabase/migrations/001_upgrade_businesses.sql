-- TapReview: migration 001 (v2)
-- Extends businesses, adds click_events, enables RLS.

begin;

-- 1. New columns (existing data is kept)
alter table public.businesses
  add column if not exists category text;
alter table public.businesses
  add column if not exists address text;
alter table public.businesses
  add column if not exists logo_url text;
alter table public.businesses
  add column if not exists brand_color text;
alter table public.businesses
  add column if not exists is_active boolean not null default true;
alter table public.businesses
  add column if not exists updated_at timestamptz not null default now();

update public.businesses
  set created_at = now()
  where created_at is null;
alter table public.businesses
  alter column created_at set not null;

-- 2. Clean up data: trim spaces, empty strings become NULL
update public.businesses set
  slug = btrim(slug),
  name = btrim(name),
  google_url = nullif(btrim(google_url), ''),
  yandex_url = nullif(btrim(yandex_url), ''),
  twogis_url = nullif(btrim(twogis_url), '');

-- 3. Unique slug
create unique index if not exists businesses_slug_key
  on public.businesses (slug);

-- 4. Data checks
alter table public.businesses
  drop constraint if exists businesses_slug_format;
alter table public.businesses
  add constraint businesses_slug_format
  check (slug ~ '^[A-Za-z0-9_-]{3,64}$');

alter table public.businesses
  drop constraint if exists businesses_name_length;
alter table public.businesses
  add constraint businesses_name_length
  check (char_length(name) between 1 and 200);

alter table public.businesses
  drop constraint if exists businesses_category_values;
alter table public.businesses
  add constraint businesses_category_values
  check (category in (
    'restaurant', 'beauty', 'shop', 'hotel', 'auto', 'other'
  ));

alter table public.businesses
  drop constraint if exists businesses_urls_https;
alter table public.businesses
  add constraint businesses_urls_https
  check (
    coalesce(google_url, 'https://') like 'https://%'
    and coalesce(yandex_url, 'https://') like 'https://%'
    and coalesce(twogis_url, 'https://') like 'https://%'
    and coalesce(logo_url, 'https://') like 'https://%'
  );

alter table public.businesses
  drop constraint if exists businesses_brand_color_hex;
alter table public.businesses
  add constraint businesses_brand_color_hex
  check (brand_color ~ '^#[0-9A-Fa-f]{6}$');

-- 5. updated_at is set automatically on every change
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists businesses_set_updated_at
  on public.businesses;
create trigger businesses_set_updated_at
  before update on public.businesses
  for each row
  execute function public.set_updated_at();

-- 6. Events table for analytics
create table if not exists public.click_events (
  id bigint generated always as identity primary key,
  business_id bigint not null
    references public.businesses (id) on delete cascade,
  event_type text not null
    check (event_type in ('page_view', 'click')),
  destination text
    check (destination in ('google', 'yandex', 'twogis')),
  source text not null default 'unknown'
    check (source in ('nfc', 'qr', 'direct', 'unknown')),
  visitor_hash text,
  created_at timestamptz not null default now(),
  constraint click_events_destination_matches_type check (
    (event_type = 'click' and destination is not null)
    or (event_type = 'page_view' and destination is null)
  )
);

create index if not exists click_events_business_created_idx
  on public.click_events (business_id, created_at desc);

-- 7. Row Level Security for businesses
alter table public.businesses enable row level security;

-- remove all old policies (in case there is an "allow all" one)
do $drop$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'businesses'
  loop
    execute format(
      'drop policy %I on public.businesses',
      p.policyname
    );
  end loop;
end
$drop$;

create policy "Public can read active businesses"
  on public.businesses
  for select
  to anon, authenticated
  using (is_active = true);

-- public key: read-only, public columns only
revoke all on public.businesses from anon, authenticated;
grant select (
  slug, name, logo_url, brand_color,
  google_url, yandex_url, twogis_url, is_active
) on public.businesses to anon, authenticated;

-- 8. click_events: no browser access (writes go via server)
alter table public.click_events enable row level security;
revoke all on public.click_events from anon, authenticated;

commit;
