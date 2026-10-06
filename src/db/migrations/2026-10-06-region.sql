-- US state on each posting, so a state-specific page (Washington first) can
-- filter on an indexed column instead of matching the location text live.
--
-- WHY A COLUMN, NOT A QUERY-TIME MATCH
--
-- The obvious implementation was `location ilike '%wa%'` on the Washington page.
-- That is the exact mistake `quiet` was created to avoid: matching a location
-- pattern against every candidate row per request was measured at a statement
-- timeout over the real corpus, and here it is wrong as well as slow — "%WA%"
-- catches Warsaw and Walla Walla County in other states, and "%washington%"
-- catches Washington, D.C. and George Washington University. The state is
-- decided once, from the same raw location the country is read from, by
-- inferUsState in src/ats/geo.ts — which is built on inferCountry and so inherits
-- every country trap already solved (Washington UK is GB and never reaches the
-- state logic; Vancouver, WA is US and resolves to WA; a bare Vancouver is BC
-- and resolves to nothing).
--
-- A PLAIN COLUMN, like `sector`, and deliberately NOT generated like `quiet`.
-- The inference has branches a SQL expression cannot carry honestly — D.C. vs
-- the state, a town called Washington in Pennsylvania, a bare city standing in
-- for its state — and geo.ts is the single source of truth a generated column
-- would have to duplicate and then drift from. So it is computed in the crawl
-- and stored here, exactly as `country` already is.
--
-- A PLAIN COLUMN, and deliberately no function change. Adding a parameter to
-- feed_page means dropping and recreating it, because Postgres treats an added
-- default parameter as an overload and calls with the old argument count then
-- become ambiguous — which has already nearly taken this site down once. The
-- Washington page reads the jobs table directly, the way /api/quiet and
-- /api/institutions do, so nothing here touches a function and the existing feed
-- cannot change behaviour.
--
-- Fills in over the next few crawls as each board is re-read, the way `sector`
-- did; run `npm run backfill:region` to populate it from the locations already
-- stored, rather than waiting. Until then the value is null, which the page
-- reports honestly rather than as "no Washington roles".
--
-- Safe to re-run.

begin;

alter table public.jobs add column if not exists region text;

-- The page's only query shape: one state, one family, newest first, open roles.
-- Partial on `region is not null` because the column is null for the majority
-- (everything outside a US state) and that majority is never queried.
create index if not exists jobs_region_idx
  on public.jobs (region, family, posted_at desc)
  where closed_at is null and region is not null;

commit;
