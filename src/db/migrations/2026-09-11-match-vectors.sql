-- Somewhere to put the map: one vector per job, one per resume.
--
-- WHAT THIS REPLACES
--
-- "Best match" today is a set overlap between the skill words found in a CV and
-- the skill words found in a job ad, computed in the browser over the 50 jobs
-- already on screen. It has two faults and they are both structural.
--
-- It cannot rank the corpus. The sort runs client-side on one page, and `fit` is
-- not in feed_page's ORDER BY at all -- p_sort='fit' matches neither branch and
-- falls through to `order by key asc`, which is alphabetical by job key.
--
-- And it is blind to two thirds of the corpus. Measured 11 September 2026:
--
--   65,818  open jobs
--   43,900  (67%) with an EMPTY matched_skills array
--      1.6  average skills per open job
--
-- It is not a missing-description problem. Greenhouse and Ashby return full
-- descriptions -- 101 real postings sampled, 8,260 characters at the median --
-- and 56% and 51% of their jobs respectively still match no skill. Real adverts
-- do not write in keywords: an ad saying "build and own our data pipelines" and
-- a CV saying "five years of ETL" are the same job and share no word.
--
-- A vector does not care about the words. Similar meaning lands in a similar
-- place, so "data pipelines" sits beside "ETL" and the 67% blank disappears.
--
-- THE SHAPE, AND WHY
--
-- halfvec(384), because the model is @cf/baai/bge-small-en-v1.5 on Cloudflare
-- Workers AI -- already the platform this site is deployed to, 10,000 free
-- Neurons a day, no new vendor. Verified against Cloudflare's model page on
-- 11 Sep: 384 output dimensions, 512 maximum input tokens.
--
-- That 512 is a real constraint and it shapes what gets embedded. A median
-- description is ~2,065 tokens, four times the limit, so the text cannot be the
-- description -- it is a short composition of title, family, specialization,
-- seniority, location, skills and the opening of the body, kept under ~400
-- tokens. Stored nowhere: see source_hash below.
--
-- halfvec rather than vector halves the storage at 2 bytes per dimension instead
-- of 4. pgvector 0.8.2 is what this project has, and halfvec has been available
-- since 0.7.0. Measured cost: ~860 bytes a row, ~57 MB across the open corpus,
-- against a database at 202 MB of a 500 MB free-plan limit.
--
-- A SEPARATE TABLE, NOT A COLUMN ON jobs
--
-- Three reasons. The crawl re-upserts every job every run, and a vector has no
-- business being in that payload -- one future edit to toJobRow that includes
-- the column as null would wipe the whole map. `jobs` is already the largest
-- table at 108 MB and stays hot. And the map can be dropped and rebuilt without
-- touching a single posting.
--
-- NO VECTOR INDEX YET, DELIBERATELY
--
-- An HNSW index roughly doubles the storage and takes real memory to build, and
-- this is a free-tier instance. At 65,818 rows a sequential scan may well be
-- fast enough, and the honest way to find out is to measure it on real data
-- rather than pay for an index on a guess. The index is its own migration, added
-- once there is a number to justify it.
--
-- WHAT IS NOT STORED
--
-- Not the description, and not the text that was embedded -- only a hash of it.
-- That is what lets the crawl skip a job whose composition has not changed
-- without keeping the prose, and it holds the line this project already draws:
-- no job description and no CV text in the database. A vector is not readable
-- back into either.
--
-- Safe to re-run.

begin;

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

create table if not exists public.job_embedding (
  -- Cascade rather than orphan: if a posting is ever deleted outright its vector
  -- is meaningless. Nothing deletes jobs today -- they are closed, not removed --
  -- so this is a guard, not a code path.
  job_key      text primary key references public.jobs(key) on delete cascade,
  embedding    halfvec(384) not null,
  -- Which model produced it. A vector from one model cannot be compared with a
  -- vector from another, so a model change has to be visible rather than
  -- inferred, and re-embedding can be scoped to the rows that need it.
  model        text not null,
  -- A hash of the text that was embedded, never the text. Lets the crawl skip a
  -- job whose composition is unchanged, which is what keeps the daily cost to
  -- new jobs only.
  source_hash  text not null,
  created_at   timestamptz not null default now()
);

-- The crawl's question is "which jobs still need a vector", which is an anti-join
-- against this table. The primary key serves it.
--
-- This partial index serves the other question: which vectors were made by a
-- model we have since moved off. Small, because the answer is normally none.
create index if not exists job_embedding_model_idx
  on public.job_embedding (model);

-- ---------------------------------------------------------------------------
-- Resumes
-- ---------------------------------------------------------------------------

-- On user_state rather than a table of its own, because it is exactly one row per
-- person and that table is now closed to the publishable key -- see
-- 2026-09-11-private-profiles.sql. A resume vector is derived from someone's CV
-- and has no business being publicly readable; before that migration it would
-- have been.
alter table public.user_state
  add column if not exists resume_embedding halfvec(384);

alter table public.user_state
  add column if not exists resume_model text;

alter table public.user_state
  add column if not exists resume_embedded_at timestamptz;

-- Bumped whenever the resume changes. Cached per-job explanations are written
-- against a particular version, so incrementing this invalidates them without
-- deleting anything.
alter table public.user_state
  add column if not exists resume_version integer not null default 0;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.job_embedding enable row level security;

-- No policy at all, which means no access for anon or authenticated. Every read
-- is server-side with the secret key, and similarity will be computed inside the
-- database rather than by shipping 57 MB of vectors to a browser. app_seats is
-- the model: RLS on, no permissive policy, zero rows to the publishable key.
--
-- Dropped by name as well, so re-running closes anything a previous attempt left
-- open.
drop policy if exists "job embeddings are publicly readable" on public.job_embedding;

-- Refuse rather than report success if either table is reachable with the
-- publishable key. A map of CVs is not something to half-protect.
do $$
declare
  leaky text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into leaky
  from pg_policies
  where schemaname = 'public'
    and tablename in ('job_embedding', 'user_state')
    and cmd = 'SELECT'
    and 'anon' = any (roles);

  if leaky is not null then
    raise exception 'anon can read vectors via: %', leaky;
  end if;
end $$;

commit;

-- Afterwards, nothing about the site changes: no vector exists yet, and the
-- feed still sorts exactly as it did. Filling the map is the next step, and it
-- happens during the crawl because that is the only moment the description text
-- exists.
