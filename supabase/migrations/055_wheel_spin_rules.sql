begin;

-- NULL keeps the previous single-rule configuration during rollout.
alter table public.businesses
  add column if not exists wheel_prize_rules jsonb;

alter table public.businesses drop constraint if exists businesses_wheel_rules_check;
alter table public.businesses add constraint businesses_wheel_rules_check check (
  case
    when wheel_prize_rules is null then true
    when jsonb_typeof(wheel_prize_rules) = 'array' then jsonb_array_length(wheel_prize_rules) <= 50
    else false
  end
);

create or replace function public.issue_wheel_gift(
  p_gift jsonb, p_prizes jsonb, p_random_index integer, p_config jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  venue public.businesses%rowtype;
  gift public.bonus_codes%rowtype;
  issued public.bonus_codes%rowtype;
  issued_at timestamptz;
  day_start timestamptz;
  spin_number bigint;
  chosen_index integer := p_random_index;
  scheduled_index integer;
begin
  gift := jsonb_populate_record(null::public.bonus_codes, p_gift);

  -- Lock the venue so overlapping spins use distinct numbers and failed inserts consume none.
  select * into venue from public.businesses where id = gift.business_id for no key update;
  if not found or not venue.is_active or venue.bonus_mode <> 'wheel'
    or venue.bonus_prizes is distinct from p_config then
    raise exception 'Wheel settings changed during the draw';
  end if;
  issued_at := clock_timestamp();

  select * into issued from public.bonus_codes
    where business_id = venue.id and visitor_key = gift.visitor_key
      and created_at > issued_at - venue.bonus_cooldown_days * interval '24 hours'
      and (reward_kind is null or reward_kind = 'friend')
    order by created_at desc limit 1;
  if found then
    return to_jsonb(issued) || jsonb_build_object('repeat', true);
  end if;

  if exists (select 1 from public.bonus_codes where business_id = venue.id and device_day = gift.device_day) then
    return jsonb_build_object('blocked', 'device');
  end if;
  day_start := date_trunc('day', issued_at at time zone 'Europe/Moscow') at time zone 'Europe/Moscow';
  if exists (
    select 1 from public.bonus_codes where business_id = venue.id and created_at >= day_start
    offset (venue.bonus_daily_limit - 1) limit 1
  ) then
    return jsonb_build_object('blocked', 'venue');
  end if;

  spin_number := venue.wheel_spin_count + 1;
  -- An owner can rename or disable a sector. Only unique active matches can win by rule.
  select sector.prize_index into scheduled_index
    from jsonb_to_recordset(coalesce(
      venue.wheel_prize_rules,
      case when venue.wheel_prize_every is not null then jsonb_build_array(
        jsonb_build_object('every', venue.wheel_prize_every, 'label', venue.wheel_prize_label)
      ) else '[]'::jsonb end
    )) as rule("every" integer, label text)
    cross join lateral (
      select (min(position) - 1)::integer as prize_index
        from jsonb_array_elements(p_prizes) with ordinality as candidate(prize, position)
        where candidate.prize->>'prize' = rule.label
        having count(*) = 1
    ) as sector
    where spin_number % nullif(rule."every", 0) = 0
    order by rule."every" desc
    limit 1;
  chosen_index := coalesce(scheduled_index, chosen_index);

  gift := jsonb_populate_record(gift, p_prizes->chosen_index);
  insert into public.bonus_codes
    (code, business_id, card_id, prize, conditions, visitor_key, device_day, created_at, valid_from, valid_until)
    values (gift.code, venue.id, gift.card_id, gift.prize, gift.conditions, gift.visitor_key, gift.device_day,
      issued_at, gift.valid_from, gift.valid_until)
    returning * into issued;
  update public.businesses set wheel_spin_count = spin_number where id = venue.id;
  return to_jsonb(issued) || jsonb_build_object('wheel_index', chosen_index);
end;
$$;

revoke execute on function public.issue_wheel_gift(jsonb, jsonb, integer, jsonb) from public, anon, authenticated;
grant execute on function public.issue_wheel_gift(jsonb, jsonb, integer, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
