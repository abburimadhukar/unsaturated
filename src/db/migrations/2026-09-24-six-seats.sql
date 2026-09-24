-- Six seats instead of four.
--
-- The cap lives here, in a trigger, rather than in application code: counting
-- in the app and then inserting lets two people who sign in at the same moment
-- both pass the count. The trigger counts inside the insert.
--
-- This function was created by hand and never had a migration of its own, so
-- this file is also the first record in the repo of what it says. The body is
-- the live one from 24 Sep 2026 with 4 changed to 6 — nothing else.
--
-- Must agree with SEAT_LIMIT in src/state/seats.ts. Apply THIS FIRST, then
-- deploy the site: with the database at 6 and the site still at 4, the site
-- just says "full" a little longer — harmless. The other order sends the
-- fifth person a sign-in link that the database then refuses.
--
-- Safe to re-run.

create or replace function public.enforce_seat_limit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  taken integer;
begin
  select count(*) into taken from public.app_seats;
  if taken >= 6 then
    raise exception 'seats_full' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

-- create or replace keeps existing grants, but restate the one that matters:
-- a trigger body has no business being callable over HTTP.
revoke execute on function public.enforce_seat_limit() from public, anon, authenticated;
