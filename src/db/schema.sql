-- Unsaturated: schema for the shared job corpus + per-tenant application pipeline.
--
-- Tenancy rule: companies/boards/jobs are GLOBAL. Saturation is a property of a
-- job, not of an applicant, so one crawl and one scoring pass serves every user.
-- Only candidate_profiles and applications are per-tenant. Crawl cost stays flat
-- as users are added.
--
-- PII rule: everything personally identifying lives in candidate_profiles alone,
-- so deletion is a single-row cascade rather than a hunt across the schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared corpus
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain        text UNIQUE,           -- canonical identity; null for ATS-only companies
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A board is one (ATS provider, tenant token) pair -- e.g. ('lever','lyrahealth').
-- This table IS the token registry; the resolver's job is to fill it.
CREATE TABLE IF NOT EXISTS boards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid REFERENCES companies(id) ON DELETE SET NULL,
  provider           text NOT NULL,
  token              text NOT NULL,
  -- Some providers need a second path segment (Workday site, Personio locale).
  extra              jsonb NOT NULL DEFAULT '{}'::jsonb,
  active             boolean NOT NULL DEFAULT true,
  last_crawled_at    timestamptz,
  last_success_at    timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_error         text,
  discovered_via     text,             -- 'apply_url' | 'manual' | 'careers_probe'
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, token)
);

CREATE INDEX IF NOT EXISTS boards_crawl_order_idx
  ON boards (active, last_crawled_at NULLS FIRST);

CREATE TABLE IF NOT EXISTS jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id         uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  external_id      text NOT NULL,      -- the ATS's own id

  title            text NOT NULL,
  description_text text,
  description_html text,

  location_raw     text,
  country          text,
  region           text,
  city             text,
  remote_type      text,               -- 'fully_remote' | 'hybrid' | 'on_site' | null
  employment_type  text,
  department       text,
  team             text,
  seniority        text,

  salary_min       numeric,
  salary_max       numeric,
  salary_currency  text,

  apply_url        text,
  listing_url      text,

  -- posted_at comes from the ATS itself, which is why direct ingest matters:
  -- aggregators overwrite it with their own crawl date and destroy the signal.
  posted_at        timestamptz,

  -- content_hash detects edits; identity_hash detects the SAME ROLE relisted
  -- under a new external_id, which is how ghost jobs are caught.
  content_hash     text NOT NULL,
  identity_hash    text NOT NULL,

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,        -- set when it stops appearing in the feed

  raw              jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, external_id)
);

CREATE INDEX IF NOT EXISTS jobs_open_idx        ON jobs (closed_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS jobs_identity_idx    ON jobs (identity_hash);
CREATE INDEX IF NOT EXISTS jobs_posted_at_idx   ON jobs (posted_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jobs_board_idx       ON jobs (board_id);

-- A role that closes and reopens with the same identity is either a ghost job or
-- an evergreen staffing req. Either way it is low-signal, and this is the table
-- the ghost classifier reads in Phase 2.
CREATE TABLE IF NOT EXISTS job_repost_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_hash    text NOT NULL,
  board_id         uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  previous_job_id  uuid REFERENCES jobs(id) ON DELETE SET NULL,
  new_job_id       uuid REFERENCES jobs(id) ON DELETE CASCADE,
  gap_days         numeric,
  detected_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_repost_identity_idx ON job_repost_events (identity_hash);

-- Phase 2 writes here. Kept separate from jobs so scoring can be recomputed and
-- versioned without rewriting the corpus.
CREATE TABLE IF NOT EXISTS job_scores (
  job_id             uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  scorer_version     text NOT NULL,
  saturation_score   numeric,          -- 0..100, higher = less contested
  discovery_friction numeric,
  application_friction numeric,
  qualification_friction numeric,
  desirability_discount numeric,
  freshness          numeric,
  ghost_risk         numeric,          -- 0..1, high = probably not a real opening
  components         jsonb NOT NULL DEFAULT '{}'::jsonb,
  scored_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_scores_rank_idx ON job_scores (saturation_score DESC);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  boards_total  int NOT NULL DEFAULT 0,
  boards_ok     int NOT NULL DEFAULT 0,
  boards_failed int NOT NULL DEFAULT 0,
  jobs_new      int NOT NULL DEFAULT 0,
  jobs_updated  int NOT NULL DEFAULT 0,
  jobs_closed   int NOT NULL DEFAULT 0,
  reposts_found int NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- All applicant PII is confined to this table. Dropping a user's row removes
-- every identifying field the system holds about them.
CREATE TABLE IF NOT EXISTS candidate_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name      text,
  email          text,
  phone          text,
  location       text,
  resume_url     text,
  resume_text    text,
  links          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Eligibility inputs. These are declared by the user and are NEVER inferred:
  -- a wrong answer here is a misrepresentation on a real application.
  work_authorization jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_sponsorship boolean,
  willing_remote_only  boolean NOT NULL DEFAULT false,
  target_countries     text[] NOT NULL DEFAULT '{}',

  skills         text[] NOT NULL DEFAULT '{}',
  years_experience numeric,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidate_profiles_user_idx ON candidate_profiles (user_id);

-- The review queue. There is deliberately no state that submits without passing
-- through 'pending_review' -> 'approved'.
DO $$ BEGIN
  CREATE TYPE application_state AS ENUM (
    'drafted',
    'pending_review',
    'approved',
    'submitted',
    'failed',
    'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  state          application_state NOT NULL DEFAULT 'drafted',

  -- Why this job surfaced, frozen at draft time so the feedback loop can learn
  -- from what the scorer believed then rather than what it believes now.
  score_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  draft          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Fields the engine refused to guess and needs a human answer for.
  open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,

  approved_at    timestamptz,
  submitted_at   timestamptz,
  failure_reason text,

  outcome        text,   -- 'no_response' | 'screen' | 'interview' | 'offer' | 'rejected'
  outcome_at     timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS applications_queue_idx ON applications (user_id, state);
CREATE INDEX IF NOT EXISTS applications_outcome_idx ON applications (outcome) WHERE outcome IS NOT NULL;
