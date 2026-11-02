-- TapReview: migration 030 — «Подарите другу»
--   Гость на экране своего подарка делится ссылкой /f/КОД. Новый гость (ещё не был в заведении) получает
--   подарок на первый визит (businesses.friend_gift). Когда кассир погасит код друга, пригласивший получает
--   свой подарок за друга (businesses.friend_reward). Не больше 3 друзей в месяц по одной ссылке.
--   guest_invites — одна ссылка на гостя и заведение (inviter_key — тот же обезличенный ключ устройства, что у подарков).
--   bonus_codes.reward_kind: 'friend' — подарок другу, 'inviter' — подарок пригласившему; invite_code — по какой ссылке.
-- Run on the server: sudo -u postgres psql -d tapreview < /opt/tapreview/site/supabase/migrations/030_friend_invites.sql
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists friend_gift text check (char_length(friend_gift) <= 60),
  add column if not exists friend_reward text check (char_length(friend_reward) <= 60);

create table if not exists public.guest_invites (
  code text primary key check (code ~ '^[a-z0-9]{8}$'),
  business_id bigint not null references public.businesses (id) on delete cascade,
  inviter_key text not null,
  created_at timestamptz not null default now(),
  unique (business_id, inviter_key)
);

alter table public.guest_invites enable row level security;
grant select, insert, delete on public.guest_invites to service_role;

alter table public.bonus_codes
  add column if not exists reward_kind text check (reward_kind in ('friend', 'inviter')),
  add column if not exists invite_code text references public.guest_invites (code) on delete set null;

create index if not exists bonus_codes_invite_idx on public.bonus_codes (invite_code, created_at) where invite_code is not null;

commit;
