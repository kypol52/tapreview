begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cards' and column_name = 'table_number'
  ) then
    alter table public.cards add column table_number text check (char_length(table_number) between 1 and 24);
    with known_tables as (
      select id, substring(trim(label) from '(?i)^(?:стол(?:ик)?[[:space:]]*№?[[:space:]]*)?([0-9][[:alnum:]/-]{0,23})$') as number
      from public.cards where is_table and label is not null
    )
    update public.cards as card set table_number = known_tables.number
      from known_tables where card.id = known_tables.id and known_tables.number is not null;
  end if;
end;
$$;

alter table public.bonus_codes
  add column if not exists issued_card jsonb,
  add column if not exists redeemed_card jsonb;

-- Previous codes retain their linked card number; historical table numbers were not recorded.
update public.bonus_codes as bonus
  set issued_card = jsonb_build_object('code', card.code)
  from public.cards as card
  where bonus.card_id = card.id and bonus.business_id = card.business_id and bonus.issued_card is null;

create or replace function public.bonus_issue_card_snapshot() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.card_id is not null then
    select jsonb_build_object('code', card.code, 'table_number', case when card.is_table then card.table_number end)
      into new.issued_card
      from public.cards as card
      where card.id = new.card_id and card.business_id = new.business_id and card.is_active;
  end if;
  return new;
end;
$$;

drop trigger if exists bonus_codes_issue_card_snapshot on public.bonus_codes;
create trigger bonus_codes_issue_card_snapshot
before insert on public.bonus_codes
for each row execute function public.bonus_issue_card_snapshot();

revoke execute on function public.bonus_issue_card_snapshot() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
