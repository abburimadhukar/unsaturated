-- "Highest paid" ranked rupees above dollars.
--
-- THE BUG, measured on the live corpus 12 September 2026
--
-- feed_page ordered on the raw number:
--
--   order by case when p_sort = 'salary'
--                 then coalesce(salary_max, salary_min, -1) end desc nulls last
--
-- One employer, Weekdayworks, publishes 19 postings in RUPEES -- Rs 500,000 to
-- Rs 10,000,000, an ordinary Indian range of roughly $6k to $120k. Rs 10,000,000
-- beats every real dollar salary on the site, so those 19 postings owned the
-- entire first page of "highest paid", apparently offering $10 million for a
-- frontend engineer. 22 INR postings in total, plus PLN, SEK, DKK, MXN, CZK and
-- CHF, all competing directly against dollars on magnitude alone.
--
-- WHAT THIS ADDS
--
-- salary_usd, a STORED GENERATED column. Always exactly what salary_max and
-- salary_currency say, so nothing has to remember to write it and it cannot
-- drift out of step with the amount it is derived from.
--
-- The rates are approximate and they will drift, and that is fine, because they
-- are used for exactly one thing: deciding which of two salaries is larger.
-- Being 10% out never changes whether Rs 10,000,000 outranks $400,000.
--
-- They are NEVER used for display. A converted figure on a job card would be an
-- invented number, which this project does not do -- the card shows what the
-- employer published, in the currency they published it in.
--
-- This table mirrors src/ats/currency.ts, which uses the same rates to reject
-- absurd values at write time. A test asserts the two agree, because two copies
-- of a rate table is two chances to be inconsistent and the symptom would be a
-- sort that disagrees with the plausibility check.
--
-- An unknown or absent currency is read as USD: the median posting is American,
-- and a wildly wrong assumption is caught by the plausibility ceiling instead.
--
-- Safe to re-run.

alter table public.jobs
  add column if not exists salary_usd numeric
  generated always as (
    coalesce(salary_max, salary_min) / case upper(coalesce(salary_currency, 'USD'))
      when 'USD' then 1.0
      when 'EUR' then 0.92
      when 'GBP' then 0.79
      when 'CAD' then 1.37
      when 'AUD' then 1.52
      when 'CHF' then 0.88
      when 'SGD' then 1.34
      when 'INR' then 84.0
      when 'JPY' then 150.0
      when 'CNY' then 7.2
      when 'MXN' then 18.0
      when 'BRL' then 5.4
      when 'ZAR' then 18.5
      when 'SEK' then 10.6
      when 'NOK' then 10.8
      when 'DKK' then 6.9
      when 'PLN' then 3.9
      when 'CZK' then 23.0
      when 'HUF' then 360.0
      when 'RON' then 4.6
      when 'TRY' then 34.0
      when 'ILS' then 3.7
      when 'AED' then 3.67
      when 'SAR' then 3.75
      when 'NZD' then 1.64
      when 'HKD' then 7.8
      when 'KRW' then 1350.0
      when 'TWD' then 32.0
      when 'THB' then 35.0
      when 'PHP' then 57.0
      when 'IDR' then 15800.0
      when 'VND' then 25000.0
      when 'MYR' then 4.4
      when 'COP' then 4000.0
      when 'CLP' then 950.0
      when 'ARS' then 1000.0
      when 'PKR' then 278.0
      when 'BDT' then 120.0
      when 'LKR' then 300.0
      when 'EGP' then 49.0
      when 'NGN' then 1600.0
      when 'KES' then 129.0
      when 'UAH' then 41.0
      when 'RUB' then 92.0
      else 1.0
    end
  ) stored;

-- Shaped like the query that reads it: open rows only, highest first. Partial
-- because closed rows are the majority within weeks and are never ordered.
create index if not exists jobs_salary_usd_idx
  on public.jobs (salary_usd desc nulls last) where closed_at is null;

-- THE FUNCTION IS PATCHED, NOT RETYPED.
--
-- feed_page is ~100 lines and every page of the site is read through it.
-- Transcribing it to change one clause is how a subtle difference gets
-- introduced. This replaces exactly the ordering clause, leaves every other byte
-- identical, and refuses rather than guessing if the clause is not found.
do $$
declare
  def text;
  old_clause text := 'case when p_sort = ''salary'' then coalesce(salary_max, salary_min, -1) end desc nulls last';
  new_clause text := 'case when p_sort = ''salary'' then coalesce(salary_usd, -1) end desc nulls last';
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'feed_page';

  if def is null then
    raise exception 'feed_page not found';
  end if;

  -- Already patched by a previous run is not a failure.
  if position(new_clause in def) > 0 then
    return;
  end if;
  if position(old_clause in def) = 0 then
    raise exception 'feed_page does not contain the expected salary ordering clause; refusing to guess';
  end if;

  execute replace(def, old_clause, new_clause);
end $$;

-- Verify, rather than assume the patch landed.
do $$
declare
  def text;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'feed_page';

  if position('coalesce(salary_usd, -1)' in def) = 0 then
    raise exception 'patch did not take';
  end if;
  if position('coalesce(salary_max, salary_min, -1)' in def) > 0 then
    raise exception 'the old raw-number ordering is still present';
  end if;
end $$;

-- Afterwards, verify from outside as well:
--
--   select title, company, salary_max, salary_currency, round(salary_usd) as usd
--   from public.jobs where closed_at is null and salary_usd is not null
--   order by salary_usd desc limit 10;
--
-- No rupee figure should be above a real dollar one.
