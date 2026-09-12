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
-- Six tables, matching production. Safe to re-run.

-- ---------------------------------------------------------------------------
-- jobs — one row per posting, keyed by "provider:token:externalId"
-- ---------------------------------------------------------------------------
-- pgvector, first, because user_state and job_embedding both declare halfvec
-- columns below and a type has to exist before a column can be it. Learned the
-- obvious way: the extension was created inside the job_embedding block, which
-- is 2,600 characters AFTER user_state already used halfvec(384), so this file
-- would have failed on a fresh database.
create extension if not exists vector;

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
  -- The same pay in dollars, for ORDERING only -- never shown. 'Highest paid'
  -- compared raw numbers, so one employer's 19 rupee postings (Rs 500,000 to
  -- Rs 10,000,000, about $6k-$120k) owned the whole first page, apparently
  -- offering $10 million for a frontend engineer. Generated, so it cannot drift
  -- from the amount it derives from. Rates in migrations/2026-09-12-salary-usd.sql,
  -- mirroring src/ats/currency.ts; a test asserts the two agree.
  -- salary_usd numeric generated always as (...) stored,  -- see that migration
  posted_at       timestamptz,
  apply_url       text,
  family          text,
  -- Second level of the taxonomy, under family. NULL means "the family is known
  -- and the kind of job is not" — never the string 'unknown', which would sort,
  -- group and index like a real answer. Queried with the '__unknown__' token,
  -- the same way country already handles undecoded locations.
  specialization  text,
  -- Which revision of the specialization rules wrote the two fields around it.
  -- The backfill skips rows already at the current version, which is what makes
  -- it restartable.
  classification_version text,
  specialization_reason  text,
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
-- Every feed query is (open) + family + specialization, so this matches the
-- workload exactly and stays small: closed rows are the majority within weeks
-- and are never queried.
create index if not exists jobs_family_specialization_idx
  on public.jobs (family, specialization) where closed_at is null;
create index if not exists jobs_classification_version_idx
  on public.jobs (classification_version) where closed_at is null;

-- Applying the specialization columns, the constraint and the rebuilt
-- feed_page / feed_facets to an existing database:
--   src/db/migrations/2026-09-04-specialization.sql

-- ---------------------------------------------------------------------------
-- boards — the crawler's registry of what to read.
--
-- This table sat empty while the list lived in discovered-boards.json. That
-- worked at 1,437 boards and does not at 15,000: several megabytes of git-tracked
-- JSON, an unreviewable diff on every discovery run. The file is now the offline
-- fallback and this is the source of truth.
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
  -- Where the token came from: 'opendata', 'commoncrawl', 'careers', 'hn',
  -- 'slug', 'manual'. Makes it possible to judge which channel is worth running.
  source               text not null default 'manual',
  -- Employer's own domain, recovered free from a board's own payload.
  domain               text,
  job_count            integer not null default 0,
  verified_at          timestamptz,
  last_ok_at           timestamptz,
  unique (provider, token)
);

create index if not exists boards_active_idx on public.boards (provider, token) where active;

-- Applying these to an existing database:
--   alter table public.boards add column if not exists source text not null default 'manual';
--   alter table public.boards add column if not exists domain text;
--   alter table public.boards add column if not exists job_count integer not null default 0;
--   alter table public.boards add column if not exists verified_at timestamptz;
--   alter table public.boards add column if not exists last_ok_at timestamptz;

-- ---------------------------------------------------------------------------
-- blocked_boards — boards that must never be crawled
--
-- The corpus is built by reading employers' own job boards, so an aggregator
-- republishing other companies' postings is the one thing that must not get in:
-- its apply links point at a middleman. Two of them were contributing 1,269
-- jobs, 8% of the feed, from 2 boards out of 12,214.
--
-- A table rather than a one-off deactivation, because discovery adds a couple of
-- hundred boards a week out of a web archive and aggregators are exactly what
-- turns up there. Enforced when discovery stores a board and again when the
-- crawl loads the list.
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_boards (
  provider   text not null,
  token      text not null,
  reason     text not null,
  blocked_at timestamptz not null default now(),
  primary key (provider, token)
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
-- Every column the live table actually has, as of 11 September 2026.
--
-- It did not, until now. first_name, last_name, resume_name, resume_size and
-- resume_path were all added by migrations and never folded back in, so a fresh
-- database built from this file came up missing five columns the code writes to.
-- That is the same drift the `site` column had, and it is worth stating the rule
-- out loud: a migration is not finished until this file would produce the same
-- table. Verified against information_schema after the match-vectors migration.
create table if not exists public.user_state (
  user_id      text primary key default 'default',
  skills       text[] not null default '{}',
  resume_chars integer not null default 0,
  updated_at   timestamptz not null default now(),
  -- 2026-09-05-user-names.sql
  first_name   text,
  last_name    text,
  -- 2026-09-06-resume-file.sql -- the uploaded file, not its text
  resume_name  text,
  resume_size  integer,
  resume_path  text,
  -- 2026-09-11-match-vectors.sql -- the resume's position on the map
  resume_embedding   halfvec(384),
  resume_model       text,
  resume_embedded_at timestamptz,
  -- Bumped when the resume changes, so cached per-job explanations written
  -- against an older version fall out of use without being deleted.
  resume_version     integer not null default 0
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
-- The publishable key is committed to a public repo, so anon is SELECT-only
-- everywhere. It was not always: user_state and job_events accepted anon
-- INSERT/UPDATE while the site wrote with that key, which let anyone holding the
-- published key overwrite a visitor's resume. Those policies were dropped once
-- SUPABASE_SECRET_KEY reached the hosting environment and the site's writes
-- began bypassing RLS. Verified empirically: with them gone, a direct PATCH from
-- outside changes zero rows while the site still saves.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- job_embedding -- one vector per posting, for resume matching
--
-- halfvec(384) because the model is @cf/baai/bge-small-en-v1.5 on Cloudflare
-- Workers AI: 384 output dimensions, 512 maximum input tokens. The 512 is why
-- the embedded text is a short composition rather than the description -- a
-- median description is ~2,065 tokens, four times the limit.
--
-- A separate table rather than a column on  on purpose. The crawl
-- re-upserts every job every run, and one future edit to toJobRow including
-- this column as null would wipe the entire map.
--
-- Neither the description nor the embedded text is stored -- only a hash of the
-- latter, which is what lets the crawl skip an unchanged job without keeping the
-- prose. A vector reads back into neither.
--
-- No vector index here deliberately: HNSW roughly doubles the storage and costs
-- memory to build on a free-tier instance, and 65,818 rows may not need one.
-- See migrations/2026-09-11-match-vectors.sql.
-- ---------------------------------------------------------------------------

create table if not exists public.job_embedding (
  job_key      text primary key references public.jobs(key) on delete cascade,
  embedding    halfvec(384) not null,
  model        text not null,
  source_hash  text not null,
  created_at   timestamptz not null default now()
);

create index if not exists job_embedding_model_idx on public.job_embedding (model);

-- Applying these to an existing database:
--   alter table public.user_state add column if not exists resume_embedding halfvec(384);
--   alter table public.user_state add column if not exists resume_model text;
--   alter table public.user_state add column if not exists resume_embedded_at timestamptz;
--   alter table public.user_state add column if not exists resume_version integer not null default 0;

alter table public.blocked_boards enable row level security;
alter table public.job_embedding enable row level security;
alter table public.jobs       enable row level security;
alter table public.boards     enable row level security;
alter table public.crawl_runs enable row level security;
alter table public.user_state enable row level security;
alter table public.job_events enable row level security;

drop policy if exists "jobs are publicly readable" on public.jobs;
create policy "jobs are publicly readable" on public.jobs
  for select to anon, authenticated using (true);

-- The site reads the registry to know what to crawl; only the crawler, holding
-- the secret key, ever writes it.
drop policy if exists "boards are publicly readable" on public.boards;
create policy "boards are publicly readable" on public.boards
  for select to anon, authenticated using (true);

drop policy if exists "blocked boards are publicly readable" on public.blocked_boards;
create policy "blocked boards are publicly readable" on public.blocked_boards
  for select to anon, authenticated using (true);

drop policy if exists "crawl runs are publicly readable" on public.crawl_runs;
create policy "crawl runs are publicly readable" on public.crawl_runs
  for select to anon, authenticated using (true);

-- NO select policy for anon or authenticated, deliberately. This table holds a
-- person's name, the skills extracted from their CV, the path to the file and
-- their reading history. `anon` is the publishable key, which is embedded in the
-- deployed page -- so a blanket policy here publishes all of it. It did: on
-- 11 Sep 2026 that key returned all seven rows, three of them real people's full
-- names. Every read is server-side with the secret key, which bypasses RLS.
-- See migrations/2026-09-11-private-profiles.sql.
drop policy if exists "user_state readable pre-auth" on public.user_state;

-- Explicitly dropped, not merely absent: re-running this file must close the
-- hole on a database where the old policies still exist.
drop policy if exists "user_state insertable pre-auth" on public.user_state;
drop policy if exists "user_state updatable pre-auth" on public.user_state;
drop policy if exists "job_events insertable pre-auth" on public.job_events;
drop policy if exists "job_events updatable pre-auth" on public.job_events;

-- Same: every job a person has opened or applied to is theirs alone.
drop policy if exists "job_events readable pre-auth" on public.job_events;
