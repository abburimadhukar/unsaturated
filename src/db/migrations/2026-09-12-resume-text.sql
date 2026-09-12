-- Keep the resume text, so it can be tailored against a job.
--
-- WHAT CHANGES, AND WHY IT WAS NOT THIS WAY BEFORE
--
-- Until now the text was deliberately thrown away. POST /api/profile received a
-- CV, extracted skill labels from it, stored `resume_chars` and discarded the
-- prose. The rule it obeyed is written down in several places in this repo: no
-- job description and no CV text in the database.
--
-- That rule existed for one reason, and the reason was correct. `user_state`
-- carried this policy:
--
--   create policy "user_state readable pre-auth" on public.user_state
--     for select to anon, authenticated using (true);
--
-- `anon` is the publishable key, which is embedded in the deployed page. On
-- 11 September 2026 a single unauthenticated request returned all seven rows —
-- three real people's full names, the skills from their CVs, and the storage path
-- to each file. Had the text been in that table, the text would have been public
-- too. Not storing it was the right call for as long as that was true.
--
-- 2026-09-11-private-profiles.sql closed it. There is now no select policy on
-- `user_state` for `anon` at all, and every read happens server-side under the
-- secret key. So the condition the rule was protecting against no longer holds,
-- and the rule can be revisited on its merits rather than inherited.
--
-- WHY IT HAS TO BE STORED AT ALL
--
-- Tailoring compares a CV against a posting, on demand, for whichever job a
-- person opens. That needs the text at request time, and the text only ever
-- existed for the few milliseconds of the upload request. The alternatives were
-- weighed: re-extracting from the stored file (nobody has uploaded one — all four
-- resumes on the site were pasted, and extraction is browser-only today), or
-- keeping it in the browser (lost on a cache clear, absent on a second device,
-- and visible to anyone sharing the laptop).
--
-- WHAT THIS IS NOT
--
-- Not a relaxation of the rule for job descriptions. Those are still never
-- stored: 66,000 postings are somebody else's copyrighted text, they change
-- underneath us, and they are re-fetchable on demand. A person's own CV on their
-- own private row is a different thing from a third party's advert.
--
-- NO BACKFILL IS POSSIBLE
--
-- `resume_chars` records that one person pasted 9,522 characters and three others
-- pasted less. The characters themselves are gone and were never anywhere else.
-- Everyone re-pastes once; there is nothing to migrate and nothing to recover.
--
-- Safe to re-run.

begin;

-- On user_state rather than a table of its own, for the same reasons
-- resume_embedding is: exactly one row per person, the table is seven rows and
-- never hot, and a CV and the vector derived from it belong in one place so they
-- cannot drift apart.
alter table public.user_state
  add column if not exists resume_text text;

comment on column public.user_state.resume_text is
  'The CV as pasted or extracted. Private: no anon select policy exists on this '
  'table and every read is server-side under the secret key. Required at request '
  'time by resume tailoring, which compares it against a job description.';

-- ---------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------

-- REFUSE rather than report success if this table is readable with the
-- publishable key.
--
-- This is the one check that matters here. The column is only defensible because
-- the policy that made profiles public was dropped, so a future migration that
-- re-added a permissive select policy would turn everyone's CV into public text
-- silently. Failing loudly at that moment is the point.
--
-- Modelled on the same check in 2026-09-11-match-vectors.sql, which guards the
-- resume vector for identical reasons.
do $$
declare
  leaky text;
begin
  select string_agg(format('%s (%s)', policyname, array_to_string(roles, ', ')), ', ')
    into leaky
  from pg_policies
  where schemaname = 'public'
    and tablename = 'user_state'
    and cmd = 'SELECT'
    and 'anon' = any (roles);

  if leaky is not null then
    raise exception
      'refusing to store CV text while anon can read user_state via: %. '
      'Drop that policy first — see 2026-09-11-private-profiles.sql.', leaky;
  end if;
end $$;

-- And confirm row-level security is actually switched on, not merely unpolicied.
-- A table with RLS disabled ignores the absence of policies entirely, so the
-- check above would pass while every row stayed readable.
do $$
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'user_state' and c.relrowsecurity
  ) then
    raise exception 'refusing to store CV text while row-level security is off on user_state';
  end if;
end $$;

commit;

-- Afterwards nothing about the site changes. The column is null for everyone
-- until each person saves their resume again, and every existing read names its
-- columns explicitly rather than selecting *, so nothing starts returning CV text
-- by accident.
