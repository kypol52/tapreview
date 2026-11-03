-- TapReview: migration 041 — «Мои заведения и подарки» в Mini App: связь телефона гостя (cookie tr_device) с его Telegram
--   app_user_devices   — какие устройства гость сам связал со своим аккаунтом Mini App (с его согласия в приложении).
--                        device_id — случайный номер из cookie tr_device; по нему сервер считает ключи визитов
--                        (guests.js visitorKeyOf) и показывает гостю ЕГО визиты, штампы и коды во всех заведениях.
--                        Заведениям это не показывается. Одно устройство — у одного аккаунта (повторная привязка переносит).
--   device_link_tokens — одноразовые ссылки «Мои штампы в Telegram» со страницы карты, живут 15 минут.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/041_guest_devices.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

create table if not exists public.app_user_devices (
  device_id text primary key check (device_id ~ '^[A-Za-z0-9]{24}$'),
  user_id bigint not null references public.app_users (id) on delete cascade,
  linked_at timestamptz not null default now()
);
create index if not exists app_user_devices_user_idx on public.app_user_devices (user_id);

create table if not exists public.device_link_tokens (
  token text primary key check (token ~ '^[A-Za-z0-9]{24}$'),
  device_id text not null check (device_id ~ '^[A-Za-z0-9]{24}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  used_at timestamptz
);
create index if not exists device_link_tokens_expires_idx on public.device_link_tokens (expires_at);

alter table public.app_user_devices enable row level security;
alter table public.device_link_tokens enable row level security;
revoke all on public.app_user_devices, public.device_link_tokens from anon, authenticated;
grant select, insert, update, delete on public.app_user_devices, public.device_link_tokens to service_role;

commit;
