-- Supabase schema, as it actually exists.
--
-- This file previously described a nine-table Postgres design that was never
-- built: it declared `companies`, `job_repost_events`, `job_scores`, `users`,
-- `candidate_profiles` and `applications`, keyed `jobs` on a uuid with
-- UNIQUE(board_id, external_id), and omitted `user_state` and `job_events` —
-- the two tables the running application depends on. Its `crawl_runs` used
-- column names the crawler does not write, so applying it would have rejected
-- the crawler's own insert. Anyone reading it to understand the data model
-- learned a fiction.
--
-- Five tables, matching production. Safe to re-run.

-- ---------------------------------------------------------------------------
-- jobs — one row per posting, keyed by "provider:token:externalId"
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  key             text primary key,
  provider        text not null,
  board_token     text not null,
  company         text not null,
  title           text not null,
  location        text,
  country         text,
  remote_type     text,
  seniority       text,
  employment_type text,
  department      text,
  salary_min      numeric,
  salary_max      numeric,
  salary_currency text,
  posted_at       timestamptz,
  apply_url       text,
  family          text,
  ai              boolean not null default false,
  matched_skills  text[]  not null default '{}',
  skill_score     integer not null default 0,
  ghost_risk      numeric not null default 0,
  -- When we first stored the row. Undated postings expire on this, so a
  -- provider that publishes no dates cannot accumulate forever.
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  -- Set when a posting stops appearing on a board that crawled successfully.
  closed_at       timestamptz
);

create index if not exists jobs_open_posted_idx
  on public.jobs (posted_at desc nulls last) where closed_at is null;
create index if not exists jobs_family_idx on public.jobs (family) where closed_at is null;
create index if not exists jobs_country_idx on public.jobs (country) where closed_at is null;

-- ---------------------------------------------------------------------------
-- boards — vestigial. The crawler reads discovered-boards.json, not this table.
-- ---------------------------------------------------------------------------
create table if not exists public.boards (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null,
  token                text not null,
  company              text not null,
  extra                jsonb not null default '{}',
  active               boolean not null default true,
  last_crawled_at      timestamptz,
  last_error           text,
  consecutive_failures integer not null default 0,
  created_at           timestamptz not null default now(),
  unique (provider, token)
);

-- ---------------------------------------------------------------------------
-- crawl_runs — one row per completed crawl. readFeed's freshness check reads
-- the newest finished_at; a run that persisted nothing is never recorded.
-- ---------------------------------------------------------------------------
create table if not exists public.crawl_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  boards_total  integer not null default 0,
  boards_ok     integer not null default 0,
  boards_failed integer not null default 0,
  jobs_scanned  integer not null default 0,
  jobs_upserted integer not null default 0,
  jobs_closed   integer not null default 0
);

-- ---------------------------------------------------------------------------
-- user_state / job_events — per visitor, keyed by an anonymous cookie id.
--
-- The 'default' column default is a leftover from when every visitor shared one
-- row; the application always supplies a real id now.
-- ---------------------------------------------------------------------------
create table if not exists public.user_state (
  user_id      text primary key default 'default',
  skills       text[] not null default '{}',
  resume_chars integer not null default 0,
  updated_at   timestamptz not null default now()
);

create table if not exists public.job_events (
  user_id text not null default 'default',
  job_key text not null,
  seen    boolean not null default true,
  applied boolean not null default false,
  at      timestamptz not null default now(),
  primary key (user_id, job_key)
);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- These policies previously existed only in the Supabase dashboard — unversioned
-- and unreviewable — while this file contained no RLS at all.
--
-- The publishable key is committed to a public repo, so anon is deliberately
-- read-only on the corpus. user_state and job_events still accept anon
-- INSERT/UPDATE because the deployed site writes with that key; once
-- SUPABASE_SECRET_KEY is set in the hosting environment those two policies
-- should be dropped, leaving anon with SELECT alone. anon DELETE is granted
-- nowhere: nothing in the application deletes, and a stranger with the
-- published key could otherwise wipe both tables.
-- ---------------------------------------------------------------------------
alter table public.jobs       enable row level security;
alter table public.boards     enable row level security;
alter table public.crawl_runs enable row level security;
alter table public.user_state enable row level security;
alter table public.job_events enable row level security;

drop policy if exists "jobs are publicly readable" on public.jobs;
create policy "jobs are publicly readable" on public.jobs
  for select to anon, authenticated using (true);

drop policy if exists "boards are publicly readable" on public.boards;
create policy "boards are publicly readable" on public.boards
  for select to anon, authenticated using (true);

drop policy if exists "crawl runs are publicly readable" on public.crawl_runs;
create policy "crawl runs are publicly readable" on public.crawl_runs
  for select to anon, authenticated using (true);

drop policy if exists "user_state readable pre-auth" on public.user_state;
create policy "user_state readable pre-auth" on public.user_state
  for select to anon, authenticated using (true);
drop policy if exists "user_state insertable pre-auth" on public.user_state;
create policy "user_state insertable pre-auth" on public.user_state
  for insert to anon, authenticated with check (true);
drop policy if exists "user_state updatable pre-auth" on public.user_state;
create policy "user_state updatable pre-auth" on public.user_state
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "job_events readable pre-auth" on public.job_events;
create policy "job_events readable pre-auth" on public.job_events
  for select to anon, authenticated using (true);
drop policy if exists "job_events insertable pre-auth" on public.job_events;
create policy "job_events insertable pre-auth" on public.job_events
  for insert to anon, authenticated with check (true);
drop policy if exists "job_events updatable pre-auth" on public.job_events;
create policy "job_events updatable pre-auth" on public.job_events
  for update to anon, authenticated using (true) with check (true);
