-- The crawl's close-scan timed out while other shards were writing.
--
-- THE BUG, measured 17 September 2026
--
-- Three of the last forty crawls failed with
--
--   crawl failed: supabase close-scan failed: canceling statement due to
--   statement timeout
--
-- (15 Sep 02:05, 15 Sep 20:36, 17 Sep 10:44). The close-scan asks for the open
-- postings of the boards a shard just crawled:
--
--   where closed_at is null and provider = $1 and board_token = any($2)
--   order by key
--
-- No index covered provider + board_token, so every call walked all 84,637 open
-- postings and threw away all but a few hundred ("Rows Removed by Filter:
-- 83038"). Quiet, that is 40-50 ms. While the other shards are writing their
-- 20,000 roles each it stretched to 7.9 s (pg_stat_statements max) against the
-- 8 s limit the API role runs under. Every failure lined up with another shard
-- mid-write, and no other workflow was running at any of them.
--
-- Shrinking the page, which the retry did, cannot help: the database reads every
-- open posting whatever the LIMIT, because it has to find them all to sort them.
--
-- WHAT THIS ADDS
--
-- A partial index on exactly that filter. A chunk of 150 boards now reads its
-- own few hundred rows (Adobe, Accenture and Abbott: 444) instead of 84,637.
-- About 3 MB. Closed postings are left out, as they are never asked for here.
--
-- CONCURRENTLY, so the crawl and the site keep writing and reading while it
-- builds. It must run outside a transaction block.
--
-- Safe to re-run.

create index concurrently if not exists jobs_open_board_idx
  on public.jobs (provider, board_token)
  where closed_at is null;
