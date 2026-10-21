-- TapReview: migration 007 (discount / loyalty code word)
-- discount_code: the code word the guest shows to staff, e.g. "ЛЕТО10".
-- discount_text: what the guest gets, e.g. "Скидка 10% на следующий визит".
-- Empty discount_code = no "Получить скидку" button on the page.
-- Safe to run several times.

alter table public.businesses
  add column if not exists discount_code text;
alter table public.businesses
  add column if not exists discount_text text;

alter table public.businesses
  drop constraint if exists businesses_discount_length;
alter table public.businesses
  add constraint businesses_discount_length
  check (
    char_length(coalesce(discount_code, '')) <= 40
    and char_length(coalesce(discount_text, '')) <= 120
  );
