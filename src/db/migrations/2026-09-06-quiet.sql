-- Quiet roles: the same work under a title nobody searches for.
--
-- People find jobs by typing a title into a box. A posting not called what they
-- typed is never seen, and collects a fraction of the applications an identical
-- job collects under the popular name. The published figures put the average
-- opening at 200-250 applications and entry-level at 400+, while remote roles
-- draw 2.5-3.4x the applicants of the same job on-site.
--
-- The corpus says the crowd funnels into very few names. Each family holds
-- thousands of distinct titles and the top twenty cover a fifth to a quarter:
--
--   cloud     9,140 jobs · 4,856 distinct titles · top 20 = 19%
--   software 14,167 jobs · 6,906 distinct titles · top 20 = 22%
--   data      7,273 jobs · 3,928 distinct titles · top 20 = 26%
--   hris      2,481 jobs · 1,308 distinct titles · top 20 = 29%
--
-- A GENERATED column, and deliberately not a function change.
--
-- The obvious implementation was another parameter on feed_page and
-- feed_facets. That means dropping and recreating both — Postgres treats an
-- added default parameter as an overload, so calls with the old argument count
-- become ambiguous and the site goes down until the new definition lands. That
-- has already nearly happened here once: a migration dropped both functions and
-- then failed to parse, and only the editor's transaction saved it.
--
-- Nothing below touches a function. The existing page cannot change behaviour,
-- because none of the code it runs is modified. Worst case, this column fails
-- to be created and the Quiet Roles page finds nothing.
--
-- STORED rather than computed per query for the same reason the parameter was
-- rejected: matching a 1,100-character regex against every candidate row timed
-- out when tried live. Stored, it is computed once here and then indexed.
--
-- Regenerate with: npm run quiet:sql
-- Do not hand-edit — src/taxonomy/quiet.ts is the source, and a test compares
-- the pattern below against it on every run.
--
-- Safe to re-run.

begin;

-- 49 magnet phrases and 3 acronyms, each accepting a hyphen or a space
-- between words, so "front end", "front-end" and "frontend" all count as one.
alter table public.jobs
  add column if not exists quiet boolean
  generated always as (title !~* '(^|[^a-z])(software[ -]?engineer|software[ -]?developer|software[ -]?development[ -]?engineer|full[ -]?stack[ -]?engineer|full[ -]?stack[ -]?developer|fullstack[ -]?engineer|backend[ -]?engineer|back[ -]?end[ -]?engineer|backend[ -]?developer|frontend[ -]?engineer|front[ -]?end[ -]?engineer|frontend[ -]?developer|front[ -]?end[ -]?developer|web[ -]?developer|mobile[ -]?engineer|ios[ -]?engineer|android[ -]?engineer|engineering[ -]?manager|devops[ -]?engineer|devops|cloud[ -]?engineer|cloud[ -]?architect|site[ -]?reliability[ -]?engineer|platform[ -]?engineer|infrastructure[ -]?engineer|network[ -]?engineer|security[ -]?engineer|solutions[ -]?architect|solution[ -]?architect|solutions[ -]?engineer|systems[ -]?engineer|data[ -]?engineer|data[ -]?scientist|data[ -]?analyst|business[ -]?analyst|analytics[ -]?engineer|machine[ -]?learning[ -]?engineer|business[ -]?intelligence[ -]?analyst|data[ -]?architect|ai[ -]?engineer|ml[ -]?engineer|aiml[ -]?engineer|workday[ -]?analyst|workday[ -]?consultant|hris[ -]?analyst|hris[ -]?manager|payroll[ -]?specialist|payroll[ -]?manager|hr[ -]?analyst|sre|sdet|swe)([^a-z]|$)') stored;

-- Covers the page's only query shape: one family, quiet, newest first, open.
create index if not exists jobs_quiet_idx
  on public.jobs (family, posted_at desc)
  where closed_at is null and quiet;

commit;
