-- TapReview: migration 010 (statistics page by private link)
-- The owner opens tapreview.ru/s/TOKEN in any browser — no Telegram, no login.
-- A link can be switched off in the admin panel (the row is deleted).
-- Safe to run several times.

begin;

create table if not exists public.stats_links (
  token text primary key,
  business_id bigint not null
    references public.businesses (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_opened_at timestamptz
);

alter table public.stats_links
  drop constraint if exists stats_links_checks;
alter table public.stats_links
  add constraint stats_links_checks check (token ~ '^[A-Za-z0-9]{24}$');

create index if not exists stats_links_business_idx
  on public.stats_links (business_id);

-- No browser access: only the server (secret key)
alter table public.stats_links enable row level security;
revoke all on public.stats_links from anon, authenticated;

grant select, insert, update, delete
  on public.stats_links to service_role;

commit;
