-- Serve the family tabs from the per-crawl snapshot, the way the default view
-- already is.
--
-- WHY
--
-- The default view was taken off the live count on 25 Sep (feed_newest for the
-- rows, facet_snapshot for the total). The FAMILY tabs were not, so a tab like
-- `?family=cloud` still ran feed_page — which counts the family's whole match for
-- its "matched" total — and feed_facets, live, on every cache miss. On the free
-- tier that count is the ~3-second query that gets cancelled and reaches the
-- visitor as "job data is temporarily unavailable" (503). Reproduced live on
-- 30 Sep 2026: `/api/feed?family=cloud&sort=newest` returned 503 on all three
-- attempts at ~6.7 s each.
--
-- WHAT THIS DOES — two additive, re-runnable changes:
--
--  1. feed_newest gains a p_family overload. Same rows-only query as the 3-arg
--     version (no count), with `and j.family = p_family` when a family is given.
--     The 3-arg function is LEFT IN PLACE, so a deployment that has not shipped
--     the new call keeps working — this adds a function, it does not replace one.
--
--  2. facet_snapshot gains a `by_family` column: a map of family -> the same
--     facet object the default view stores, written once per crawl. A family tab
--     reads its entry instead of counting live. Nullable, so the column can exist
--     before the next crawl fills it; until then each family falls back to the
--     live count, exactly as today.
--
-- feed_page is NOT touched. Every filtered view beyond a bare family tab keeps
-- using it. Safe to re-run.

alter table public.facet_snapshot
  add column if not exists by_family jsonb;

create or replace function public.feed_newest(
  p_cutoff  timestamptz,
  p_offset  integer,
  p_limit   integer,
  p_family  text
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
      -- The only addition over the 3-arg version: narrow to one family when asked.
      and (p_family is null or j.family = p_family)
    order by j.posted_at desc nulls last, j.key asc
    offset p_offset
    limit  p_limit
  )
  select jsonb_build_object(
    -- Same row shape as feed_page and the 3-arg feed_newest, including what they
    -- strip.
    'rows', coalesce(
      (select jsonb_agg(
         to_jsonb(j) - 'specialization_reason' - 'classification_version'
         order by pg.posted_at desc nulls last, pg.key asc)
       from page pg join jobs j on j.key = pg.key),
      '[]'::jsonb)
  );
$$;

grant execute on function public.feed_newest(timestamptz, integer, integer, text)
  to anon, authenticated, service_role;
