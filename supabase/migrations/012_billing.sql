-- TapReview: migration 012 (subscription)
-- paid_until    — last paid day (Moscow). Empty = no subscription, the business always works.
--                 After paid_until there are 3 grace days, then the card sends guests straight
--                 to Yandex Maps / 2GIS / Google and the owner's statistics is paused.
-- monthly_price — price per month in rubles (for the income summary in the admin panel)
-- billing_note  — admin's note: how they pay, contact, discount, etc.
-- Safe to run several times. Existing businesses get no paid_until — nothing switches off.

begin;

alter table public.businesses
  add column if not exists paid_until date,
  add column if not exists monthly_price integer,
  add column if not exists billing_note text;

alter table public.businesses
  drop constraint if exists businesses_billing_checks;
alter table public.businesses
  add constraint businesses_billing_checks check (
    (monthly_price is null or monthly_price between 0 and 1000000)
    and char_length(coalesce(billing_note, '')) <= 200
  );

commit;
