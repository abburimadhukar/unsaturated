-- Undoes src/db/migrations/2026-09-17-feed-narrow.sql.
--
-- The exact reverse of its replacements, so the functions return to the bytes
-- they had before. Checked 17 Sep 2026: forward then back reproduces the
-- original definitions' md5 (feed_facets 2cb83c6f…, feed_page a7368bbe…).
-- Already rolled back is not an error.

do $$
declare
  nl  constant text := chr(13) || chr(10);
  def text;
  f_old constant text := 'select * from public.jobs j';
  f_new constant text := 'select j.family, j.country, j.remote_type, j.seniority, j.provider, j.matched_skills, j.specialization, j.adjacent from public.jobs j';
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
  select pg_get_functiondef('public.feed_facets'::regproc) into def;
  if position(f_new in def) > 0 then
    execute replace(def, f_new, f_old);
  end if;

  select pg_get_functiondef('public.feed_page'::regproc) into def;
  if position(p2_new in def) > 0 then
    execute replace(replace(def, p2_new, p2_old), p1_new, p1_old);
  end if;
end $$;
