-- TapReview: migration 051 — оплата счёта со стола (модуль «Сервис в зале», src/pay.js)
--   businesses.pay_on — заведение принимает оплату счёта по QR (СБП). Включается в админке.
--   table_bills   — счёт стола: официант вводит сумму на странице вызовов. Суммы — в копейках.
--                   paid растёт с каждой успешной оплатой; paid >= amount → status 'paid'.
--   bill_payments — платёж гостя: kind 'bill' (часть счёта) или 'tip' (чаевые официанту, вторым шагом).
--                   fee — сервисный сбор TapReview сверху (3%), total = amount + fee — столько платит гость.
--                   token — публичный номер платежа в ссылках (24 символа), provider_id — номер у банка.
--   bill_payment_settle(token, status) — отметить платёж (уведомление банка): один раз, повтор ничего не меняет;
--                   успешная оплата части счёта сразу прибавляется к счёту в той же транзакции.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/051_table_pay.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.businesses
  add column if not exists pay_on boolean not null default false;

create table if not exists public.table_bills (
  id bigint generated always as identity primary key,
  business_id bigint not null references public.businesses (id) on delete cascade,
  card_id bigint references public.cards (id) on delete set null,
  place text not null check (char_length(place) between 1 and 60),
  amount integer not null check (amount between 100 and 100000000),
  paid integer not null default 0 check (paid >= 0),
  split smallint check (split between 1 and 10),
  staff_id bigint references public.staff (id) on delete set null,
  created_by text check (char_length(created_by) <= 80),
  status text not null default 'open' check (status in ('open', 'paid', 'closed')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  closed_at timestamptz
);
create index if not exists table_bills_card_idx on public.table_bills (card_id, created_at desc);
create index if not exists table_bills_business_idx on public.table_bills (business_id, created_at desc);
create index if not exists table_bills_active_idx on public.table_bills (business_id) where status <> 'closed';

create table if not exists public.bill_payments (
  id bigint generated always as identity primary key,
  token text not null unique check (token ~ '^[A-Za-z0-9]{24}$'),
  bill_id bigint not null references public.table_bills (id) on delete cascade,
  business_id bigint not null references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('bill', 'tip')),
  amount integer not null check (amount between 100 and 100000000),
  fee integer not null check (fee >= 0),
  total integer not null check (total = amount + fee),
  staff_id bigint references public.staff (id) on delete set null,
  provider text not null check (char_length(provider) <= 20),
  provider_id text check (char_length(provider_id) <= 80),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'canceled')),
  visitor_hash text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists bill_payments_bill_idx on public.bill_payments (bill_id);
create index if not exists bill_payments_business_idx on public.bill_payments (business_id, created_at desc);

alter table public.table_bills enable row level security;
alter table public.bill_payments enable row level security;
revoke all on public.table_bills, public.bill_payments from anon, authenticated;
grant select, insert, update, delete on public.table_bills, public.bill_payments to service_role;

create or replace function public.bill_payment_settle(p_token text, p_status text)
returns table (changed boolean, kind text, bill_id bigint, bill_status text, bill_paid integer, bill_amount integer)
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  pay public.bill_payments%rowtype;
  bill public.table_bills%rowtype;
begin
  if p_status not in ('succeeded', 'canceled') then
    raise exception 'bad status %', p_status;
  end if;
  update public.bill_payments p
     set status = p_status, paid_at = case when p_status = 'succeeded' then now() end
   where p.token = p_token and p.status = 'pending'
  returning * into pay;
  if not found then
    select * into pay from public.bill_payments p where p.token = p_token;
    select * into bill from public.table_bills b where b.id = pay.bill_id;
    return query select false, pay.kind, bill.id, bill.status, bill.paid, bill.amount;
    return;
  end if;
  if p_status = 'succeeded' and pay.kind = 'bill' then
    update public.table_bills b
       set paid = b.paid + pay.amount,
           status = case when b.status = 'open' and b.paid + pay.amount >= b.amount then 'paid' else b.status end,
           paid_at = case when b.paid_at is null and b.paid + pay.amount >= b.amount then now() else b.paid_at end
     where b.id = pay.bill_id
    returning * into bill;
  else
    select * into bill from public.table_bills b where b.id = pay.bill_id;
  end if;
  return query select true, pay.kind, bill.id, bill.status, bill.paid, bill.amount;
end;
$fn$;

revoke all on function public.bill_payment_settle(text, text) from public, anon, authenticated;
grant execute on function public.bill_payment_settle(text, text) to service_role;

commit;
