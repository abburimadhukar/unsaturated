-- A rows-only twin of feed_page, for filtered views that still time out cold.
--
-- WHY
--
-- Route A took the default view and the bare family tabs off the live count.
-- Every OTHER filtered view — a family AND a country, a search, a seniority —
-- still goes through feed_page, which counts the whole match for its "matched"
-- total. Measured live 1 Oct 2026, `?family=cloud&country=US` returned 503 cold
-- at 6.8 s: the count over that intersection exceeds the 3-second statement
-- limit. The 50 rows themselves are cheap; it is the count that is not.
--
-- The counts the sidebar needs for that same view are ALREADY computed in
-- parallel by feed_facets (adjacent.core is the core total, equal to feed_page's
-- total when adjacent roles are excluded — the default). So the total does not
-- need feed_page at all. feed_rows returns the page WITHOUT either count, and the
-- route uses it as a fallback when feed_page's count times out, taking the total
-- from the facets.
--
-- WHAT THIS IS
--
-- feed_page's body, byte-for-byte, with ONLY the `total` and `undated` counts
-- removed from the final object. The filter (the `filtered` CTE) and the ordering
-- and paging (the `page` CTE) are identical, so feed_rows returns exactly the rows
-- feed_page would for the same arguments — verified by comparing the two over
-- several filter sets after applying (see the comparison in the deploy notes).
--
-- feed_page itself is NOT touched — this adds a function beside it, the same way
-- feed_newest did. If feed_page's filter ever changes, this must be regenerated
-- from its new definition; it is a copy, not a view onto it.
--
-- SECURITY DEFINER and the search_path match feed_page. Safe to re-run.

create or replace function public.feed_rows(
  p_cutoff timestamptz,
  p_in_scope boolean default true,
  p_family text default null,
  p_country text default null,
  p_remote text default null,
  p_seniority text default null,
  p_employment text default null,
  p_provider text default null,
  p_q text default null,
  p_has_salary boolean default false,
  p_min_salary numeric default null,
  p_within_days integer default null,
  p_ai boolean default false,
  p_hide_ghosts boolean default false,
  p_keep_unknown boolean default true,
  p_sort text default 'newest',
  p_offset integer default 0,
  p_limit integer default 50,
  p_stack text default null,
  p_specialization text default null,
  p_adjacent text default null
) returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  with filtered as (
    select j.key, j.posted_at, j.salary_usd
    from public.jobs j
    where j.closed_at is null
      and (not p_in_scope or j.family is not null)
      and (j.posted_at >= p_cutoff
           or (j.posted_at is null and j.first_seen_at >= p_cutoff))
      and (p_family     is null or j.family      = p_family)
      and (p_family = 'unsorted' or coalesce(j.family, '') <> 'unsorted')
      and (p_provider   is null or j.provider    = p_provider)
      and (p_stack is null or public.stack_of(j.matched_skills) = p_stack)
      and (p_specialization is null
           or (p_specialization =  '__unknown__' and j.specialization is null)
           or (p_specialization <> '__unknown__' and j.specialization = p_specialization))
      and (p_country is null
           or (p_country = '__unknown__' and j.country is null)
           or (p_country <> '__unknown__' and j.country = p_country))
      and (p_remote     is null or j.remote_type = p_remote
           or (p_keep_unknown and j.remote_type is null))
      and (p_seniority  is null or j.seniority   = p_seniority
           or (p_keep_unknown and j.seniority is null))
      and (p_employment is null
           or lower(regexp_replace(coalesce(j.employment_type,''),'[^a-zA-Z]','','g'))
              like '%' || lower(regexp_replace(p_employment,'[^a-zA-Z]','','g')) || '%'
           or (p_keep_unknown and j.employment_type is null))
      and (not p_has_salary or j.salary_min is not null or j.salary_max is not null)
      and (p_min_salary is null or coalesce(j.salary_max, j.salary_min, 0) >= p_min_salary)
      and (p_within_days is null
           or j.posted_at >= now() - make_interval(days => p_within_days)
           or (j.posted_at is null and p_keep_unknown
               and j.first_seen_at >= now() - make_interval(days => p_within_days)))
      and (case
             when p_adjacent = 'include' then true
             when p_adjacent = 'only'    then coalesce(j.adjacent, false)
             else not coalesce(j.adjacent, false)
           end)
      and (not p_ai or j.ai)
      and (not p_hide_ghosts or coalesce(j.ghost_risk, 0) < 0.4)
      and (p_q is null or p_q = ''
           or j.title ilike '%' || p_q || '%'
           or j.company ilike '%' || p_q || '%'
           or coalesce(j.location,'') ilike '%' || p_q || '%')
  ),
  page as (
    select * from filtered
    order by
      case when p_sort = 'salary' then coalesce(salary_usd, -1) end desc nulls last,
      case when p_sort = 'newest' then posted_at end desc nulls last,
      key asc
    offset p_offset
    limit  p_limit
  )
  select jsonb_build_object(
    'rows',  coalesce(
               (select jsonb_agg(
                  to_jsonb(j) - 'specialization_reason' - 'classification_version'
                  order by
                    case when p_sort = 'salary' then coalesce(pg.salary_usd, -1) end desc nulls last,
                    case when p_sort = 'newest' then pg.posted_at end desc nulls last,
                    pg.key asc)
                from page pg join public.jobs j on j.key = pg.key),
               '[]'::jsonb)
  );
$function$;

grant execute on function public.feed_rows(
  timestamptz, boolean, text, text, text, text, text, text, text, boolean,
  numeric, integer, boolean, boolean, boolean, text, integer, integer, text, text, text
) to anon, authenticated, service_role;
