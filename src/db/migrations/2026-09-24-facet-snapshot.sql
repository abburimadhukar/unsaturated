-- The filter counts, worked out once per crawl instead of once per page view.
--
-- `feed_facets` is 16% of all database time: 26,377 calls at a 273ms mean and
-- a 2,992ms worst case. That is TWICE what `feed_page` costs — counting the
-- filter options is more expensive than fetching the jobs being filtered.
--
-- It is expensive for a good reason. `feed_page` finds 50 rows and stops;
-- feed_facets has to sweep all ~39,700 matching rows and tally them by family,
-- then country, then provider, seniority, remote type, specialization, stack
-- and adjacency. Eight passes over forty thousand rows to produce ~30 numbers.
--
-- And it was being recomputed on every page view, thousands of times between
-- crawls, always returning the same answer — because the corpus only changes
-- when a crawl finishes. The work was never buying freshness.
--
-- WHY THIS IS A CORRECTNESS FIX, NOT JUST A SPEED ONE
--
-- facetsFromDb returns null for a refusal, and app/api/feed/route.ts fills in
-- EMPTY facets for a null. So when the count query ran out of time the page
-- rendered with every filter at zero and the total reading 0, with the jobs
-- listed right beside them. Caught live on 24 Sep:
--
--   {"total":0,"facets":{"family":{},"country":{},"provider":{}}}
--   {"total":669191,"facets":{"family":{"cloud":12437,"software":17258}}}
--
-- Same endpoint, seconds apart. Not an error page — a site that looks empty,
-- which is what "I'm not seeing any data" turned out to be. A stored number
-- cannot time out, so this removes the failure rather than narrowing it.
--
-- ONLY THE UNFILTERED VIEW
--
-- feed_facets takes the caller's filters, so its answer differs per filter
-- combination and one row cannot stand in for all of them. This caches the
-- DEFAULT view only — no family, no country, no search — which is what every
-- visitor lands on and the case that was failing. A filtered request still
-- computes live, exactly as before.
--
-- Safe to re-run.

create table if not exists public.facet_snapshot (
  -- Exactly one row, enforced by the type rather than by convention: a boolean
  -- primary key that must be true has precisely one legal value.
  id           boolean primary key default true check (id),
  facets       jsonb  not null,
  computed_at  timestamptz not null default now()
);

-- Readable by anyone, writable only by the crawler holding the secret key —
-- the same rule the rest of the schema follows.
alter table public.facet_snapshot enable row level security;

drop policy if exists "facet snapshot is publicly readable" on public.facet_snapshot;
create policy "facet snapshot is publicly readable" on public.facet_snapshot
  for select to anon, authenticated using (true);
