-- Make the exclusions tally cheap to write, which it never was.
--
-- The table does its job well: it is the receipt for the ~93% of postings the
-- crawl discards, and it already folds a quarter of a million rows an hour down
-- to a few thousand totals before writing. The problem was never the volume.
--
-- The problem was WHICH column got indexed.
--
-- Every write does `set n = n + excluded.n`. Two indexes were built on `n`, so
-- `n` is both the hottest column in the table and an indexed one. Postgres can
-- only take the cheap in-page path (a HOT update) when no indexed column
-- changes, so it took the expensive path every single time: a fresh copy of the
-- row plus three index entries rewritten. The statistics are unambiguous —
--
--   updates                11,721,136
--   of those, HOT                   0      (0.0%)
--
-- Zero, not "low". For contrast `boards`, updated just as hard, runs at 92.7%.
-- That is the whole reason a table holding 37 MB of text occupies 99 MB.
--
-- What the two indexes bought, measured over the same period:
--
--   exclusions_reason_n_idx   16 MB      39 scans
--   exclusions_n_idx          15 MB     671 scans
--
-- 710 reads against 11.7 million writes they made expensive. And they were
-- close to unusable anyway: src/cli/exclusions.ts pages through the ENTIRE
-- table, and an index cannot help a query that reads every row.
--
-- exclusions_pkey (reason, title) STAYS. It carries 12,036,179 scans — it is
-- what finds the row to add the count to, and dropping it would break the
-- upsert entirely.
--
-- No UI consequence of any kind: nothing under app/ reads this table. The site
-- queries jobs, boards, user_state, job_events and app_seats, and that is all.
-- This is instrumentation, read by hand through `npm run exclusions`.

drop index if exists public.exclusions_reason_n_idx;
drop index if exists public.exclusions_n_idx;

-- Leave room on each page for the in-place updates that are now possible.
--
-- Dropping the indexes permits HOT; fillfactor is what lets it actually happen.
-- A HOT update needs spare room on the SAME page as the original row, and the
-- default of 100 packs pages full, so the first update to a row on a full page
-- has to move it anyway and the win is only partial. 85 reserves a margin.
--
-- Applies to pages written from here on — it does not rewrite what exists.
alter table public.exclusions set (fillfactor = 85);
