-- The Quiet Roles and Institutions counts, in one query each instead of
-- seventeen.
--
-- Both pages counted their tabs and their country dropdown with a separate
-- `count=exact` request per option: 4 families + 12 countries + "location
-- unclear" on Quiet Roles, 17 more on Institutions. Each re-reads the same
-- matching rows — one of them, measured 25 Sep 2026, touched 7,549 table pages
-- to count 2,451 roles — and all of them arrive at once.
--
-- On the free database that burst crowds out everyone else. The same day the
-- log shows 49 statement timeouts in one hour with no crawl running, mostly on
-- the MAIN feed, clustered in the minutes Quiet Roles was being browsed. And a
-- count that timed out was shown as 0 rather than as missing.
--
-- Measured on the live data, 25 Sep 2026: the Quiet Roles counts for one
-- family take ~0.2s and ~25,700 buffer reads as one query, against ~120,000
-- across the seventeen separate counts. About a fifth of the work, and one
-- request instead of a burst.
--
-- These read the matching rows once (the CTE is referenced more than once, so
-- Postgres materialises it) and tally every option from that single pass. The
-- filters are the ones the routes applied through PostgREST, spelled the same
-- way: `neq` there is `<>` here, so a NULL is excluded exactly as before.
--
-- Read-only, security invoker: they see exactly what the caller could already
-- read from `jobs`. Safe to re-run.

create or replace function public.quiet_facets(
  p_cutoff      timestamptz,
  p_family      text,
  p_families    text[],
  p_on_site     boolean default false,
  p_no_entry    boolean default false,
  p_mid_market  boolean default false,
  p_syndicated  text[]  default '{}',
  p_seniority   text    default null,
  p_paid_only   boolean default false,
  p_q           text    default null
) returns jsonb
language sql
stable
set search_path = public
as $$
  with m as (
    select family, country
    from jobs
    where closed_at is null
      and quiet = true
      and adjacent = false
      -- The tabs on the page, passed in. Without it the scan also tallies
      -- ~48,500 unsorted rows the page never shows: 17,417 rows instead of
      -- 65,935, measured 25 Sep 2026.
      and family = any (p_families)
      and (posted_at >= p_cutoff or (posted_at is null and first_seen_at >= p_cutoff))
      and (not p_on_site or remote_type <> 'fully_remote')
      and (not p_no_entry or seniority <> 'entry')
      and (not p_mid_market or provider <> all (p_syndicated))
      and (p_seniority is null or seniority = p_seniority)
      and (not p_paid_only or salary_min is not null)
      and (p_q is null or title ilike '%' || p_q || '%' or company ilike '%' || p_q || '%')
  )
  select jsonb_build_object(
    -- The tabs: every family, ignoring the country (see the route).
    'counts', (
      select coalesce(jsonb_object_agg(family, n), '{}'::jsonb)
      from (select family, count(*) n from m group by family) x
    ),
    -- The dropdown: countries within the family being looked at.
    'countries', (
      select coalesce(jsonb_object_agg(country, n), '{}'::jsonb)
      from (select country, count(*) n from m
            where family = p_family and country is not null group by country) x
    ),
    'countryUnknown', (select count(*) from m where family = p_family and country is null)
  );
$$;

create or replace function public.institution_facets(
  p_cutoff          timestamptz,
  p_family          text    default null,
  p_quiet           boolean default false,
  p_specialization  text    default null,
  p_q               text    default null,
  p_sector          text    default null
) returns jsonb
language sql
stable
set search_path = public
as $$
  with m as (
    select sector, country, specialization,
           -- The two filters the specialization dropdown deliberately ignores.
           ((p_specialization is null or specialization = p_specialization)
             and (p_q is null or title ilike '%' || p_q || '%' or company ilike '%' || p_q || '%')) as hit
    from jobs
    where closed_at is null
      and sector is not null
      and family is not null
      and adjacent = false
      and (posted_at >= p_cutoff or (posted_at is null and first_seen_at >= p_cutoff))
      and (p_family is null or family = p_family)
      and (not p_quiet or quiet = true)
  )
  select jsonb_build_object(
    -- The tabs: every sector, ignoring the country and the chosen sector.
    'counts', (
      select coalesce(jsonb_object_agg(sector, n), '{}'::jsonb)
      from (select sector, count(*) n from m where hit group by sector) x
    ),
    'countries', (
      select coalesce(jsonb_object_agg(country, n), '{}'::jsonb)
      from (select country, count(*) n from m
            where hit and country is not null and (p_sector is null or sector = p_sector)
            group by country) x
    ),
    'countryUnknown', (
      select count(*) from m
      where hit and country is null and (p_sector is null or sector = p_sector)
    ),
    -- Over the whole sector, not narrowed by the specialization or the search.
    'specializations', (
      select coalesce(jsonb_object_agg(specialization, n), '{}'::jsonb)
      from (select specialization, count(*) n from m
            where specialization is not null and (p_sector is null or sector = p_sector)
            group by specialization) x
    )
  );
$$;

grant execute on function public.quiet_facets(timestamptz, text, text[], boolean, boolean, boolean, text[], text, boolean, text)
  to anon, authenticated, service_role;
grant execute on function public.institution_facets(timestamptz, text, boolean, text, text, text)
  to anon, authenticated, service_role;
