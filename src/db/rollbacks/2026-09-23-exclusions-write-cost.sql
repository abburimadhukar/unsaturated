-- Undo 2026-09-23-exclusions-write-cost.sql.
--
-- Rebuilding the indexes costs a minute on ~293,000 rows and returns the table
-- to 0% HOT updates, so only run this if `npm run exclusions` has actually
-- become too slow to use — which, on a table this size, would be surprising.
--
-- Safe to re-run.

create index if not exists exclusions_reason_n_idx
  on public.exclusions (reason, n desc);
create index if not exists exclusions_n_idx
  on public.exclusions (n desc);

alter table public.exclusions set (fillfactor = 100);
