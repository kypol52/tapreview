-- TapReview: migration 020 (links to the venue's menu / catalogue / services on the review page)
-- extra_links — up to 6 buttons: [{ "type": "menu" | "catalog" | "services" | "booking" | "delivery" | "site" | "custom",
--                                   "url": "https://…", "label": "own caption (for custom)" }]
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/020_extra_links.sql
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists extra_links jsonb not null default '[]'::jsonb;

alter table public.businesses drop constraint if exists businesses_extra_links_check;
alter table public.businesses
  add constraint businesses_extra_links_check check (
    jsonb_typeof(extra_links) = 'array' and jsonb_array_length(extra_links) <= 6
  );

commit;
