-- The default feed view — no filters, newest first — without recounting it.
--
-- WHY
--
-- This is the view every visitor lands on, and feed_page answered it by
-- counting every match (~40,000 rows) to report the "matched" total, and by
-- sorting through a CASE expression that no index can serve. Measured on the
-- live database, 25 Sep 2026:
--
--   feed_page, default view                  2,631 ms   (anon's limit: 3,000)
--   just the count of the matches            2,895 ms
--   the 50 newest rows, plain ORDER BY           5 ms   (jobs_open_posted_idx)
--
-- So nearly all of it was the count, and it ran within a few hundred
-- milliseconds of the timeout. When the CDN copy expired and nobody else had
-- visited, the next person paid it — and sometimes got "job data is temporarily
-- unavailable" (503) instead. Three such cancellations at 15:15 that day.
--
-- WHAT THIS DOES
--
-- Returns only the rows, in exactly feed_page's order for sort = 'newest'
-- (its salary CASE is NULL then, so the order is posted_at desc nulls last,
-- key asc). The total comes from the sidebar counts instead: `adjacent.core`
-- in feed_facets is the same number — checked at the same instant on 25 Sep
-- 2026, feed_page total 39,970 and feed_facets core 39,970 — and for this view
-- it is already stored per crawl in facet_snapshot.
--
-- feed_page itself is NOT changed. Every filtered view keeps using it exactly
-- as before; this serves one query shape only, and the route falls back to
-- feed_page if anything here is missing.
--
-- The filters are feed_page's with every parameter at its default: in scope,
-- inside the window, not the unsorted review queue, core roles only.
--
-- Security invoker, unlike feed_page: `jobs` is publicly readable (policy
-- `true` for anon and authenticated, every column granted), so the caller's
-- own rights return the same rows without borrowing the owner's. Safe to
-- re-run.

create or replace function public.feed_newest(
  p_cutoff  timestamptz,
  p_offset  integer default 0,
  p_limit   integer default 50
) returns jsonb
language sql
stable
set search_path = public
as $$
  with page as (
    select j.key, j.posted_at
    from jobs j
    where j.closed_at is null
      and j.family is not null
      and (j.posted_at >= p_cutoff or (j.posted_at is null and j.first_seen_at >= p_cutoff))
      and coalesce(j.family, '') <> 'unsorted'
      and not coalesce(j.adjacent, false)
    order by j.posted_at desc nulls last, j.key asc
    offset p_offset
    limit  p_limit
  )
  select jsonb_build_object(
    -- Same row shape as feed_page, including what it strips.
    'rows', coalesce(
      (select jsonb_agg(
         to_jsonb(j) - 'specialization_reason' - 'classification_version'
         order by pg.posted_at desc nulls last, pg.key asc)
       from page pg join jobs j on j.key = pg.key),
      '[]'::jsonb)
  );
$$;

grant execute on function public.feed_newest(timestamptz, integer, integer)
  to anon, authenticated, service_role;
