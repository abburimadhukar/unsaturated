-- Stop publishing everyone's name, skills and reading history.
--
-- WHAT WAS WRONG
--
-- `user_state` and `job_events` each carried a select policy granting `anon`
-- every row:
--
--   create policy "user_state readable pre-auth" on public.user_state
--     for select to anon, authenticated using (true);
--
-- `anon` is the publishable key. That key is embedded in the deployed page and
-- visible in any browser's network tab, so whatever it may read, the public may
-- read. Verified against the live database on 11 September 2026 using nothing
-- else:
--
--   GET /rest/v1/user_state?select=user_id,first_name,last_name,skills,resume_path
--   -> HTTP 200, all 7 rows
--
-- Three real people's full names came back, with the skills extracted from their
-- CVs, the size of each resume and the storage path to the file. `job_events`
-- likewise returned every job each of them had opened or applied to.
--
-- `src/state/identity.ts` already states the rule this broke: a stranger must
-- not be able to read the owner's resume-derived skills. The policy said
-- otherwise for as long as both existed.
--
-- WHY IT COULD NOT SIMPLY BE DROPPED BEFORE NOW
--
-- `src/state/store.ts` read profiles with that same publishable key, so closing
-- the policy would have closed the application's own read and emptied every
-- profile page. The read moved to the secret key first, in the commit before
-- this migration, and was deployed and verified live before this ran. That
-- ordering is the whole reason this is a separate step.
--
-- WHAT REPLACES THEM: NOTHING, DELIBERATELY
--
-- No narrower select policy is added, because no browser needs one. Every read
-- of these tables happens server-side in an API route holding the secret key,
-- which is `service_role` and bypasses RLS entirely. Adding an owner-scoped
-- policy would grant access nothing asks for, and half of these rows cannot be
-- owner-scoped anyway: an anonymous visitor's `user_id` is a cookie hash with no
-- `auth.uid()` behind it.
--
-- `app_seats` is the model being followed here. It holds email addresses, has no
-- permissive policy, and returns zero rows to the publishable key — because
-- `src/state/auth.ts` reads it as the signed-in user rather than as `anon`.
--
-- AFTER THIS RUNS
--
--   the publishable key          0 rows from user_state and job_events
--   the site                     unchanged; it reads with the secret key
--   the crawler                  unaffected; it never touches these tables
--
-- Safe to re-run. Dropping a policy that is already gone is not an error with
-- `if exists`, and the verification block at the end only reads.

begin;

-- Explicitly dropped by name, not merely left absent. Re-running this file on a
-- database where the old policy still exists must CLOSE the hole, which is the
-- same reasoning schema.sql gives for its own `drop policy if exists` lines.
drop policy if exists "user_state readable pre-auth" on public.user_state;
drop policy if exists "job_events readable pre-auth" on public.job_events;

-- Belt and braces: RLS is what makes the absence of a policy mean "no access".
-- A table with RLS disabled and no policies is readable by everyone, which is
-- the opposite of what dropping these is for.
alter table public.user_state enable row level security;
alter table public.job_events enable row level security;

-- Fail loudly rather than reporting success if anything still grants `anon` a
-- blanket read. A migration about privacy that quietly half-applied would be
-- worse than one that refused.
do $$
declare
  leftover text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into leftover
  from pg_policies
  where schemaname = 'public'
    and tablename in ('user_state', 'job_events')
    and cmd = 'SELECT'
    and 'anon' = any (roles)
    and coalesce(qual, 'true') = 'true';

  if leftover is not null then
    raise exception 'anon can still read every row via: %', leftover;
  end if;
end $$;

commit;

-- Verify by hand afterwards, with the publishable key and nothing else:
--
--   curl -s "$SUPABASE_URL/rest/v1/user_state?select=user_id" \
--        -H "apikey: $PUBLISHABLE" -H "authorization: Bearer $PUBLISHABLE"
--
-- An empty array is the correct answer. A row is a failure.
