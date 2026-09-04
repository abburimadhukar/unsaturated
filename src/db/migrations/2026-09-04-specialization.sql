-- Specialization: the second level of the taxonomy, under family.
--
-- Safe to re-run. Adds three nullable columns, two partial indexes and a CHECK
-- constraint, then replaces feed_page and feed_facets. It never deletes a row,
-- never rewrites family, and never touches boards, user_state or job_events.
--
-- Apply with the Supabase SQL editor (see the README section this migration is
-- referenced from) or `psql "$SUPABASE_DB_URL" -f` this file. Nothing in the
-- application applies it automatically.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
-- specialization is NULL for "the family is known, the kind of job is not".
-- Deliberately not the string 'unknown': a sentinel value would sort, group and
-- index like a real answer, and every count(*) group by specialization would
-- report a guess as a category. The API asks for these rows with the
-- '__unknown__' token, exactly as the country filter already does.
alter table public.jobs add column if not exists specialization        text;
-- Which revision of the rules produced the row. The backfill uses it as a
-- restart marker, so a run that dies halfway resumes instead of starting over.
alter table public.jobs add column if not exists classification_version text;
-- Short debugging note: "Title matched Backend", "Generic Software title;
-- Backend evidence found in the description". Never served to the browser.
alter table public.jobs add column if not exists specialization_reason  text;

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
-- Every feed query is (closed_at is null) + family + specialization, so the
-- partial index matches the workload exactly and stays small — closed rows are
-- the majority after a few weeks and are never queried.
create index if not exists jobs_family_specialization_idx
  on public.jobs (family, specialization) where closed_at is null;

-- The backfill's "what have I not done yet" scan.
create index if not exists jobs_classification_version_idx
  on public.jobs (classification_version) where closed_at is null;

-- ---------------------------------------------------------------------------
-- 3. A specialization must belong to its family
-- ---------------------------------------------------------------------------
-- The rule is already enforced in the classifier (a family's rule set contains
-- only its own values) and in the API (400 on a mismatched pair). This is the
-- last line: a bad write fails loudly here rather than producing a row that no
-- filter combination can ever return.
--
-- NOT VALID, then validated separately: adding it as valid would scan the whole
-- table inside the same statement. Every existing row has specialization NULL,
-- so the validation passes instantly — but doing it in two steps keeps this
-- re-runnable on a table that has since been filled.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_specialization_family_chk'
  ) then
    alter table public.jobs add constraint jobs_specialization_family_chk check (
      specialization is null
      or (family = 'software' and specialization in (
            'frontend','backend','fullstack','mobile','qa_test',
            'application_integration','embedded_systems','general_software'))
      or (family = 'cloud' and specialization in (
            'devops_sre','platform_engineering','cloud_infrastructure','networking',
            'cloud_security','systems_storage','finops','general_cloud'))
      or (family = 'data' and specialization in (
            'data_engineering','analytics_bi','data_science','ml_engineering',
            'mlops','database_administration','general_data'))
      or (family = 'hris' and specialization in (
            'workday','successfactors','oracle_hcm','ukg','payroll_benefits','general_hris'))
    ) not valid;
  end if;
end $$;

alter table public.jobs validate constraint jobs_specialization_family_chk;

-- ---------------------------------------------------------------------------
-- 4. Replace the query functions
-- ---------------------------------------------------------------------------
-- Dropped by signature rather than CREATE OR REPLACE: adding a parameter makes
-- a NEW overload and leaves the old one in place, after which a PostgREST RPC
-- call by named arguments is ambiguous and fails at runtime. The loop drops
-- every overload of both names, so re-running this file is always clean.
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
      and (p_within_days is null
           or j.posted_at is null
           or j.posted_at >= now() - make_interval(days => p_within_days))
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
      and (p_within_days is null
           or j.posted_at is null
           or j.posted_at >= now() - make_interval(days => p_within_days))
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
