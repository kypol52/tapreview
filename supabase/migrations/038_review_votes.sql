-- TapReview: migration 038 — «Полезный отзыв»
--   review_votes   — кто отметил отзыв полезным (один голос от пользователя на отзыв);
--   reviews.helpful — счётчик голосов, его ведёт триггер (так сортировка «Полезные» не считает голоса каждый раз).
--   Удаление пользователя или отзыва убирает его голоса, триггер уменьшает счётчик.
-- Run on the server: sudo cat /opt/tapreview/site/supabase/migrations/038_review_votes.sql | sudo -u postgres psql -d tapreview -v ON_ERROR_STOP=1
--   then: sudo systemctl restart postgrest
-- Safe to run several times.

begin;

alter table public.reviews
  add column if not exists helpful integer not null default 0;

create table if not exists public.review_votes (
  review_id bigint not null references public.reviews (id) on delete cascade,
  user_id bigint not null references public.app_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (review_id, user_id)
);
create index if not exists review_votes_user_idx on public.review_votes (user_id);

create or replace function public.review_votes_count()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    update public.reviews set helpful = helpful + 1 where id = new.review_id;
    return new;
  else
    update public.reviews set helpful = greatest(helpful - 1, 0) where id = old.review_id;
    return old;
  end if;
end;
$fn$;

drop trigger if exists review_votes_count on public.review_votes;
create trigger review_votes_count
  after insert or delete on public.review_votes
  for each row
  execute function public.review_votes_count();

-- updated_at отзыва меняется, только если изменился сам отзыв, а не счётчик голосов
create or replace function public.reviews_touch()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if (new.score, new.text, new.photo_id, new.status, new.reject_reason, new.card_id,
      new.reply_text, new.reply_at, new.moderated_at, new.edited_at, new.business_id, new.user_id)
     is not distinct from
     (old.score, old.text, old.photo_id, old.status, old.reject_reason, old.card_id,
      old.reply_text, old.reply_at, old.moderated_at, old.edited_at, old.business_id, old.user_id) then
    new.updated_at = old.updated_at;
  else
    new.updated_at = now();
  end if;
  return new;
end;
$fn$;

drop trigger if exists reviews_set_updated_at on public.reviews;
create trigger reviews_set_updated_at
  before update on public.reviews
  for each row
  execute function public.reviews_touch();

-- Пересчёт на случай повторного запуска
update public.reviews r
  set helpful = coalesce((select count(*) from public.review_votes v where v.review_id = r.id), 0)
  where r.helpful is distinct from coalesce((select count(*) from public.review_votes v where v.review_id = r.id), 0);

create index if not exists reviews_business_helpful_idx on public.reviews (business_id, status, helpful desc, created_at desc);

alter table public.review_votes enable row level security;
revoke all on public.review_votes from anon, authenticated;
grant select, insert, delete on public.review_votes to service_role;

commit;
