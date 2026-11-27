begin;

alter table public.bonus_codes
  add column if not exists guest_applied_at timestamptz,
  add column if not exists guest_receipt text;

alter table public.bonus_codes drop constraint if exists bonus_guest_apply_check;
alter table public.bonus_codes add constraint bonus_guest_apply_check check (
  (guest_applied_at is null and guest_receipt is null)
  or (guest_applied_at is not null and guest_receipt is not null and guest_receipt ~ '^[A-Z2-9]{8}$')
);

create unique index if not exists bonus_codes_guest_receipt_key on public.bonus_codes (guest_receipt)
  where guest_receipt is not null;
create index if not exists bonus_codes_business_redeemed_idx on public.bonus_codes (business_id, redeemed_at desc, id desc)
  where redeemed_at is not null;

notify pgrst, 'reload schema';

commit;
