-- An index for the filtered feed views that still timed out cold.
--
-- WHY
--
-- After Route A fixed the bare family tabs, a family AND a country together — the
-- heaviest common filter, e.g. cloud + US — still 503'd cold. The plan showed
-- why: there were single-column indexes on `family` and on `country`, but none on
-- both, so Postgres scanned every one of ~16,600 cloud rows and re-checked the
-- country and the window on each. Measured 1 Oct 2026, the count alone was 6.4 s
-- against anon's 3-second limit.
--
--   count(cloud + US), before: 6,387 ms  (Index Scan on jobs_family_idx, 16,612
--                                          rows scanned, 11,758 removed by filter)
--   count(cloud + US), after:    727 ms  (Index Scan on this index, 1,672 removed)
--   feed_page(cloud + US):     6,400 ms -> 2,600 ms
--
-- WHAT
--
-- A composite, partial index on the two columns the feed filters by, with
-- posted_at so the page's `order by posted_at desc` is served by the same index
-- rather than a separate sort. Partial on open rows only (closed_at is null),
-- like every other feed index here, so it stays small — the feed never looks at
-- closed postings.
--
-- family is the leading column, so this also serves a family-only filter; a
-- country-only filter keeps using jobs_country_idx. It does NOT remove the need
-- for the database move (docs/step2-database-move.md): the very heaviest combo can
-- still edge over the limit on a cold cache under load, where the feed_rows
-- fallback and the edge cache catch it. It moves the common case comfortably
-- under the limit. Safe to re-run.

create index if not exists jobs_family_country_posted_idx
  on public.jobs (family, country, posted_at desc)
  where (closed_at is null);
