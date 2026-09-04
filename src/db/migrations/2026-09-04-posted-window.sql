-- "Posted within 24 hours" was letting undated postings through unbounded.
--
-- The window filter read:
--
--   and (p_within_days is null
--        or j.posted_at is null            <-- unconditional escape hatch
--        or j.posted_at >= now() - make_interval(days => p_within_days))
--
-- so every posting with no publish date satisfied every window. Measured on the
-- live corpus: "past 24 hours" returned 1,393 roles of which 364 were undated,
-- and 355 of those had been first seen more than a day earlier — one of them
-- four days earlier. Because the sort is `posted_at desc nulls last`, they all
-- landed after the dated ones, so the first page looked right and the stale rows
-- only appeared once you scrolled. That is exactly how it was reported.
--
-- Two things were wrong, not one:
--
--   1. Undated rows were never bounded. first_seen_at is when WE first stored
--      the row — a fact we own rather than a date we invented — and the 21-day
--      retention cutoff already uses it for precisely this purpose. The window
--      now does the same, so an undated posting counts as "within N days" only
--      if we first saw it within N days.
--
--   2. The bypass ignored p_keep_unknown, so unchecking "include jobs with
--      missing details" did nothing here. Every other nullable dimension —
--      remote, seniority, employment type — is gated on it. This one is now too.
--
-- feed_page also returns `undated`: how many of the matched rows have no posting
-- date, counted over the whole match rather than the current page. Without it
-- the header can say "1,393 roles" while a quarter of them have no known date,
-- and nothing on screen admits it.
--
-- Safe to re-run.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('feed_page', 'feed_facets')
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

create function public.feed_page(
  p_cutoff        timestamptz,
  p_in_scope      boolean  default true,
  p_family        text     default null,
  p_country       text     default null,
  p_remote        text     default null,
  p_seniority     text     default null,
  p_employment    text     default null,
  p_provider      text     default null,
  p_q             text     default null,
  p_has_salary    boolean  default false,
  p_min_salary    numeric  default null,
  p_within_days   integer  default null,
  p_ai            boolean  default false,
  p_hide_ghosts   boolean  default false,
  p_keep_unknown  boolean  default true,
  p_sort          text     default 'newest',
  p_offset        integer  default 0,
  p_limit         integer  default 50,
  p_stack         text     default null,
  p_specialization text    default null
) returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with filtered as (
    select j.*
    from public.jobs j
    where j.closed_at is null
      and (not p_in_scope or j.family is not null)
      and (j.posted_at >= p_cutoff
           or (j.posted_at is null and j.first_seen_at >= p_cutoff))
      and (p_family     is null or j.family      = p_family)
      and (p_provider   is null or j.provider    = p_provider)
      -- Exact, with unknown a deliberate choice rather than a side effect.
      and (p_stack is null or public.stack_of(j.matched_skills) = p_stack)
      -- Same shape as country, and for the same reason: "unknown" is its own
      -- request, never something p_keep_unknown quietly folds into a real
      -- answer. Asking for Frontend must not return rows we could not place.
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
      -- Undated postings are bounded by when WE first saw them, and leave
      -- entirely when the caller turns off "include jobs with missing details".
      -- Waving them through unconditionally is what made "past 24 hours" show
      -- rows first seen four days earlier.
      and (p_within_days is null
           or j.posted_at >= now() - make_interval(days => p_within_days)
           or (j.posted_at is null and p_keep_unknown
               and j.first_seen_at >= now() - make_interval(days => p_within_days)))
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
      case when p_sort = 'salary' then coalesce(salary_max, salary_min, -1) end desc nulls last,
      case when p_sort = 'newest' then posted_at end desc nulls last,
      key asc
    offset p_offset
    limit  p_limit
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    -- Over the whole match, not the current page. The sort puts undated rows
    -- last, so a per-page count reports zero on page one and the caller learns
    -- nothing until they have already scrolled past it.
    'undated', (select count(*) from filtered where posted_at is null),
    -- The two classifier-debugging columns are stripped here rather than
    -- selected around: this response is CDN-cached and read by a browser that
    -- displays neither, and a sentence of prose per row is pure payload.
    'rows',  coalesce(
               (select jsonb_agg(
                  to_jsonb(page) - 'specialization_reason' - 'classification_version')
                from page),
               '[]'::jsonb)
  );
$function$;

create function public.feed_facets(
  p_cutoff        timestamptz,
  p_in_scope      boolean  default true,
  p_hide_ghosts   boolean  default false,
  p_family        text     default null,
  p_country       text     default null,
  p_remote        text     default null,
  p_seniority     text     default null,
  p_employment    text     default null,
  p_provider      text     default null,
  p_q             text     default null,
  p_has_salary    boolean  default false,
  p_min_salary    numeric  default null,
  p_within_days   integer  default null,
  p_ai            boolean  default false,
  p_keep_unknown  boolean  default true,
  p_stack         text     default null,
  p_specialization text    default null
) returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with base as (
    select * from public.jobs j
    where j.closed_at is null
      and (not p_in_scope or j.family is not null)
      and (j.posted_at >= p_cutoff
           or (j.posted_at is null and j.first_seen_at >= p_cutoff))
      and (not p_hide_ghosts or coalesce(j.ghost_risk, 0) < 0.4)
      and (not p_has_salary or j.salary_min is not null or j.salary_max is not null)
      and (p_min_salary is null or coalesce(j.salary_max, j.salary_min, 0) >= p_min_salary)
      -- Undated postings are bounded by when WE first saw them, and leave
      -- entirely when the caller turns off "include jobs with missing details".
      -- Waving them through unconditionally is what made "past 24 hours" show
      -- rows first seen four days earlier.
      and (p_within_days is null
           or j.posted_at >= now() - make_interval(days => p_within_days)
           or (j.posted_at is null and p_keep_unknown
               and j.first_seen_at >= now() - make_interval(days => p_within_days)))
      and (not p_ai or j.ai)
      and (p_q is null or p_q = ''
           or j.title ilike '%' || p_q || '%'
           or j.company ilike '%' || p_q || '%'
           or coalesce(j.location,'') ilike '%' || p_q || '%')
      and (p_employment is null
           or lower(regexp_replace(coalesce(j.employment_type,''),'[^a-zA-Z]','','g'))
              like '%' || lower(regexp_replace(p_employment,'[^a-zA-Z]','','g')) || '%'
           or (p_keep_unknown and j.employment_type is null))
  ),
  -- Each facet applies every OTHER active filter but never its own dimension;
  -- applying its own would show every unselected option as zero and make it
  -- impossible to switch away from the current choice.
  for_family as (
    select * from base where
      (p_country is null or (p_country = '__unknown__' and country is null)
        or (p_country <> '__unknown__' and country = p_country))
      and (p_remote is null or remote_type = p_remote or (p_keep_unknown and remote_type is null))
      and (p_seniority is null or seniority = p_seniority or (p_keep_unknown and seniority is null))
      and (p_provider is null or provider = p_provider)
      and (p_stack is null or public.stack_of(matched_skills) = p_stack)
      and (p_specialization is null
           or (p_specialization =  '__unknown__' and specialization is null)
           or (p_specialization <> '__unknown__' and specialization = p_specialization))
  ),
  for_country as (
    select * from base where
      (p_family is null or family = p_family)
      and (p_remote is null or remote_type = p_remote or (p_keep_unknown and remote_type is null))
      and (p_seniority is null or seniority = p_seniority or (p_keep_unknown and seniority is null))
      and (p_provider is null or provider = p_provider)
      and (p_stack is null or public.stack_of(matched_skills) = p_stack)
      and (p_specialization is null
           or (p_specialization =  '__unknown__' and specialization is null)
           or (p_specialization <> '__unknown__' and specialization = p_specialization))
  ),
  for_remote as (
    select * from base where
      (p_family is null or family = p_family)
      and (p_country is null or (p_country = '__unknown__' and country is null)
        or (p_country <> '__unknown__' and country = p_country))
      and (p_seniority is null or seniority = p_seniority or (p_keep_unknown and seniority is null))
      and (p_provider is null or provider = p_provider)
      and (p_stack is null or public.stack_of(matched_skills) = p_stack)
      and (p_specialization is null
           or (p_specialization =  '__unknown__' and specialization is null)
           or (p_specialization <> '__unknown__' and specialization = p_specialization))
  ),
  for_seniority as (
    select * from base where
      (p_family is null or family = p_family)
      and (p_country is null or (p_country = '__unknown__' and country is null)
        or (p_country <> '__unknown__' and country = p_country))
      and (p_remote is null or remote_type = p_remote or (p_keep_unknown and remote_type is null))
      and (p_provider is null or provider = p_provider)
      and (p_stack is null or public.stack_of(matched_skills) = p_stack)
      and (p_specialization is null
           or (p_specialization =  '__unknown__' and specialization is null)
           or (p_specialization <> '__unknown__' and specialization = p_specialization))
  ),
  for_provider as (
    select * from base where
      (p_family is null or family = p_family)
      and (p_country is null or (p_country = '__unknown__' and country is null)
        or (p_country <> '__unknown__' and country = p_country))
      and (p_remote is null or remote_type = p_remote or (p_keep_unknown and remote_type is null))
      and (p_seniority is null or seniority = p_seniority or (p_keep_unknown and seniority is null))
      and (p_stack is null or public.stack_of(matched_skills) = p_stack)
      and (p_specialization is null
           or (p_specialization =  '__unknown__' and specialization is null)
           or (p_specialization <> '__unknown__' and specialization = p_specialization))
  ),
  for_stack as (
    select * from base where
      (p_family is null or family = p_family)
      and (p_country is null or (p_country = '__unknown__' and country is null)
        or (p_country <> '__unknown__' and country = p_country))
      and (p_remote is null or remote_type = p_remote or (p_keep_unknown and remote_type is null))
      and (p_seniority is null or seniority = p_seniority or (p_keep_unknown and seniority is null))
      and (p_provider is null or provider = p_provider)
      and (p_specialization is null
           or (p_specialization =  '__unknown__' and specialization is null)
           or (p_specialization <> '__unknown__' and specialization = p_specialization))
  ),
  -- Everything except the specialization choice itself, which is what makes the
  -- counts change as you move between families and stay put as you move between
  -- specializations. p_family IS applied: the list only ever renders under a
  -- selected family, so these are that family's counts.
  for_specialization as (
    select * from base where
      (p_family is null or family = p_family)
      and (p_country is null or (p_country = '__unknown__' and country is null)
        or (p_country <> '__unknown__' and country = p_country))
      and (p_remote is null or remote_type = p_remote or (p_keep_unknown and remote_type is null))
      and (p_seniority is null or seniority = p_seniority or (p_keep_unknown and seniority is null))
      and (p_provider is null or provider = p_provider)
      and (p_stack is null or public.stack_of(matched_skills) = p_stack)
  ),
  run as (
    select max(finished_at) as finished_at,
           sum(jobs_scanned) filter (
             where finished_at > (select max(finished_at) from public.crawl_runs) - interval '30 minutes'
           ) as scanned
    from public.crawl_runs where finished_at is not null
  )
  select jsonb_build_object(
    'family',    (select coalesce(jsonb_object_agg(family, n), '{}'::jsonb)
                  from (select family, count(*) n from for_family where family is not null group by family) x),
    'country',   (select coalesce(jsonb_object_agg(country, n), '{}'::jsonb)
                  from (select country, count(*) n from for_country where country is not null group by country) x),
    'countryUnknown', (select count(*) from for_country where country is null),
    'remote',    (select coalesce(jsonb_object_agg(remote_type, n), '{}'::jsonb)
                  from (select remote_type, count(*) n from for_remote where remote_type is not null group by remote_type) x),
    'provider',  (select coalesce(jsonb_object_agg(provider, n), '{}'::jsonb)
                  from (select provider, count(*) n from for_provider group by provider) x),
    'seniority', (select coalesce(jsonb_object_agg(seniority, n), '{}'::jsonb)
                  from (select seniority, count(*) n from for_seniority where seniority is not null group by seniority) x),
    'stack',     (select coalesce(jsonb_object_agg(st, n), '{}'::jsonb)
                  from (select public.stack_of(matched_skills) st, count(*) n from for_stack group by 1) x),
    -- NULL is counted, not skipped, under the same token the filter accepts —
    -- so the option the UI offers and the number beside it are the same query.
    'specialization', (select coalesce(jsonb_object_agg(sp, n), '{}'::jsonb)
                  from (select coalesce(specialization, '__unknown__') sp, count(*) n
                        from for_specialization group by 1) x),
    'inScope',   (select count(*) from public.jobs
                  where closed_at is null and family is not null
                    and (posted_at >= p_cutoff or (posted_at is null and first_seen_at >= p_cutoff))),
    'refreshedAt', (select finished_at from run),
    'scanned',     (select coalesce(scanned, 0) from run)
  );
$function$;

-- Restored explicitly. The default grant to PUBLIC would cover it, but the site
-- calls both of these with the publishable key and an accidental REVOKE
-- elsewhere would take the feed down with a permissions error.
grant execute on function public.feed_page(
  timestamptz, boolean, text, text, text, text, text, text, text, boolean,
  numeric, integer, boolean, boolean, boolean, text, integer, integer, text, text
) to anon, authenticated;

grant execute on function public.feed_facets(
  timestamptz, boolean, boolean, text, text, text, text, text, text, text,
  boolean, numeric, integer, boolean, boolean, text, text
) to anon, authenticated;
