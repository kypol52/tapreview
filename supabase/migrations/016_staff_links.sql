-- TapReview: migration 016 (staff link: cashier/waiter can only check and redeem gift codes)
-- tapreview.ru/k/TOKEN opens a page with ONE function: check a guest's gift code and redeem it.
-- No statistics, no settings, no admin panel. One link per business (or several, e.g. per shift);
-- switching a link off = deleting the row.
-- Safe to run several times.

begin;

create table if not exists public.staff_links (
  token text primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.staff_links
  drop constraint if exists staff_links_checks;
alter table public.staff_links
  add constraint staff_links_checks check (
    token ~ '^[A-Za-z0-9]{24}$'
    and char_length(coalesce(label, '')) <= 60
  );

create index if not exists staff_links_business_idx on public.staff_links (business_id);

-- Who redeemed the code: owner's stats link or a staff link (its label)
alter table public.bonus_codes
  add column if not exists redeemed_by text;

alter table public.staff_links enable row level security;
revoke all on public.staff_links from anon, authenticated;
grant select, insert, update, delete on public.staff_links to service_role;

commit;
