-- The feed carried whole rows it only needed to count.
--
-- THE PROBLEM, measured 17 September 2026
--
-- /api/feed took 1.7-2.9 s uncached, and 44 calls of feed_page in 24 hours were
-- cancelled by the 3-second statement limit the site's role runs under, each one
-- a visitor told "job data is temporarily unavailable". They clustered on crawl
-- hours.
--
-- Both functions build their working set with `select *`, and Postgres
-- materialises a CTE that is read more than once:
--
--   feed_facets  ~69,000 whole rows (~500 bytes each), read seven times,
--                plus a second whole-row read for the adjacent facet
--   feed_page    ~33,000 whole rows, read three times, to return 50
--
-- On the same 32,738 rows: counting directly 73 ms, materialising whole rows
-- 320 ms, materialising only the counted columns 115 ms.
--
-- WHAT THIS CHANGES
--
-- feed_facets reads only the eight columns the facets use. feed_page works with
-- key, posted_at and salary_usd — enough to filter, count and order — and
-- fetches full rows for the page alone, ordered by the same expression as the
-- page itself. Measured on copies: facets 1,051 ms -> 430 ms, page
-- 150 ms -> 100 ms, output byte-identical on every parameter set compared.
--
-- If a later edit filters a facet on a column not listed here, CREATE fails
-- loudly ("column does not exist"). It cannot return wrong counts quietly.
--
-- THE FUNCTIONS ARE PATCHED, NOT RETYPED, as in 2026-09-12-salary-usd.sql:
-- exact pieces are replaced, every other byte stays as it is, and a piece that is
-- not found is refused rather than guessed at. Already patched is not an error.
-- CREATE OR REPLACE keeps the existing grants.
--
-- Undo: src/db/rollbacks/2026-09-17-feed-narrow.sql reverses exactly these
-- pieces, byte for byte (checked by md5 on 17 Sep).

do $$
declare
  nl  constant text := chr(13) || chr(10);
  def text;
  -- feed_facets: `base` and `for_adjacent` each read every column.
  f_old constant text := 'select * from public.jobs j';
  f_new constant text := 'select j.family, j.country, j.remote_type, j.seniority, j.provider, j.matched_skills, j.specialization, j.adjacent from public.jobs j';
  -- feed_page: the filtered set, then the rows of the page.
  p1_old constant text := 'select j.*' || nl || '    from public.jobs j';
  p1_new constant text := 'select j.key, j.posted_at, j.salary_usd' || nl || '    from public.jobs j';
  p2_old constant text :=
    '(select jsonb_agg(' || nl ||
    '                  to_jsonb(page) - ''specialization_reason'' - ''classification_version'')' || nl ||
    '                from page)';
  p2_new constant text :=
    '(select jsonb_agg(' || nl ||
    '                  to_jsonb(j) - ''specialization_reason'' - ''classification_version''' || nl ||
    '                  -- Must match the ORDER BY of `page` above.' || nl ||
    '                  order by' || nl ||
    '                    case when p_sort = ''salary'' then coalesce(pg.salary_usd, -1) end desc nulls last,' || nl ||
    '                    case when p_sort = ''newest'' then pg.posted_at end desc nulls last,' || nl ||
    '                    pg.key asc)' || nl ||
    '                from page pg join public.jobs j on j.key = pg.key)';
begin
  -- feed_facets
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'feed_facets';
  if def is null then
    raise exception 'feed_facets not found';
  end if;
  if position(f_new in def) = 0 then
    if (length(def) - length(replace(def, f_old, ''))) / length(f_old) <> 2 then
      raise exception 'feed_facets does not contain exactly two whole-row reads; refusing to guess';
    end if;
    execute replace(def, f_old, f_new);
  end if;

  -- feed_page
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'feed_page';
  if def is null then
    raise exception 'feed_page not found';
  end if;
  if position(p2_new in def) = 0 then
    if position(p1_old in def) = 0 then
      raise exception 'feed_page does not contain the expected filtered select; refusing to guess';
    end if;
    if position(p2_old in def) = 0 then
      raise exception 'feed_page does not contain the expected rows clause; refusing to guess';
    end if;
    execute replace(replace(def, p1_old, p1_new), p2_old, p2_new);
  end if;
end $$;

-- Verify, rather than assume the patch landed.
do $$
declare
  f text;
  p text;
begin
  select pg_get_functiondef('public.feed_facets'::regproc) into f;
  select pg_get_functiondef('public.feed_page'::regproc) into p;
  if position('select * from public.jobs' in f) > 0 then
    raise exception 'feed_facets still reads whole rows';
  end if;
  if position('select j.*' in p) > 0 or position('to_jsonb(page)' in p) > 0 then
    raise exception 'feed_page still carries whole rows';
  end if;
  if position('join public.jobs j on j.key = pg.key' in p) = 0 then
    raise exception 'feed_page does not fetch the page rows';
  end if;
end $$;
