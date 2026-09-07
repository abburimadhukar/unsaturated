-- One employer, several career sites.
--
-- THE PROBLEM
--
-- A Workday address is {tenant}.{shard}.myworkdayjobs.com/{site}. The tenant is
-- the customer account; the site is ONE careers portal inside it, and a customer
-- may run many. The Nevada System of Higher Education is a single tenant with a
-- portal per campus:
--
--   nshe / GBC-external   Great Basin College          18 jobs
--   nshe / UNR-external   University of Nevada, Reno  133 jobs
--
-- `boards` carried `unique (provider, token)` and the token is the TENANT, so
-- the table could hold exactly one site per employer. Every other portal had
-- nowhere to go.
--
-- Measured on three discovery runs: 765 live boards found and 352 stored, 843
-- and 414, 906 and 442. Roughly 430 VERIFIED LIVE Workday boards are discarded
-- every run, because they are additional sites of a tenant already registered.
-- Discovery has been finding them correctly all along; only storage refused them.
--
-- Verified 7 Sep 2026: two sites of one tenant share NO job ids at all, so these
-- are genuinely different postings rather than the same ones seen twice.
--
-- THE CHANGE
--
-- `site` is a generated column, so nothing has to remember to write it — it is
-- always exactly what `extra` says. For every provider other than Workday there
-- is no site in `extra`, so it is the empty string and
-- unique (provider, token, '') behaves precisely as unique (provider, token)
-- did. Nothing else changes identity.
--
-- Safe to re-run.

begin;

alter table public.boards
  add column if not exists site text
  generated always as (coalesce(extra->>'site', '')) stored;

-- Dropped by lookup rather than by name: the old constraint was created
-- implicitly and its name is whatever Postgres chose. Anything unique on
-- exactly (provider, token) is the one being replaced.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'boards'
      and con.contype = 'u'
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(con.conkey) k
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k
      ) = array['provider','token']
  loop
    execute format('alter table public.boards drop constraint %I', c.conname);
  end loop;
end $$;

-- The new identity. A unique INDEX rather than a constraint so it can be
-- created concurrently later if this table ever grows large enough to care.
create unique index if not exists boards_provider_token_site_key
  on public.boards (provider, token, site);

commit;

-- After this, upsertBoards conflicts on (provider, token, site) and a tenant can
-- hold every one of its career sites. Existing rows are untouched: they all have
-- site = whatever extra already said, which for non-Workday boards is ''.
