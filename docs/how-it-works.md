# How Unsaturated actually works

**Written 8 September 2026.** A reference for the code, the database and the
workflows — what each one does, and how that was established.

---

## How to read this

Every factual claim below is tagged with how it was checked:

| Tag | Means |
|---|---|
| **[code]** | Read in the source, file and line named |
| **[db]** | Queried against the live database on 8 Sep 2026 |
| **[run]** | Read from a GitHub Actions run log, run id named |
| **[probe]** | Measured by making a real request to a vendor or the live site |
| **[unverified]** | Stated in existing docs or comments; I could not confirm it |

Where I could not establish something, it says so. Nothing here is inferred
from a file name or assumed from a comment — comments in this repo are usually
accurate, but two of them were wrong when checked and those are listed at the
end.

**The database is the source of truth, not `src/db/schema.sql`.** That file has
drifted; see [Corrections](#corrections-to-existing-documentation).

---

## The system in one page

Unsaturated reads job postings directly from employers' own hiring systems —
Workday, Greenhouse, Ashby and nine others — rather than from any job board or
aggregator. Three things run on a loop:

```
  DISCOVER (weekly)          CRAWL (hourly-ish)              SERVE (on request)
  ────────────────           ──────────────────              ──────────────────
  Common Crawl URL index     read every active board         Cloudflare Worker
    ↓ extract board tokens     ↓ fetch its postings            ↓
  verify each one live       classify each posting           reads Postgres directly
    ↓ keep the ones alive      ↓ keep the in-scope ones        ↓
  boards table               jobs table                      no rebuild needed
```

Live at **https://unsaturated-jobs.rarejobs.workers.dev** [probe: all pages
answered 200 on 8 Sep].

Measured 8 Sep 2026 [db]:

```
boards      25,572 rows      25,205 active     367 retired
jobs        85,124 rows      61,950 open
exclusions 160,366 rows      (titles the classifier discarded, counted)
crawl_runs     289 rows
user_state       7 rows
job_events     303 rows
app_seats        3 rows
blocked_boards   4 rows
```

---

## The database

Postgres 17.6.1.166, Supabase project `vupjabahniolbnbmeidk`, region
`us-east-1` [db].

### `boards` — the registry of what to crawl

Columns [db, `information_schema.columns`]:

```
id                   uuid          primary key
provider             text          'workday', 'greenhouse', …
token                text          the employer's identifier at that vendor
company              text          not null
extra                jsonb         Workday: {host, site, locale}. UKG: {host, board}
active               boolean       false = not crawled
last_crawled_at      timestamptz
last_error           text
consecutive_failures integer
created_at           timestamptz
source               text          'commoncrawl', 'seed-file', 'manual', …
domain               text          employer's own domain, when a payload reveals it
job_count            integer
verified_at          timestamptz
last_ok_at           timestamptz
site                 text          GENERATED ALWAYS AS (coalesce(extra->>'site',''))
```

**`site` is a generated column.** It is always exactly what `extra->>'site'`
says and cannot be written directly [db]. Verified on 8 Sep: `site` is never
NULL, it is `''` on all 22,261 non-Workday rows, and it matches `extra.site` on
all 3,311 Workday rows — zero mismatches [db].

Indexes [db, `pg_indexes`]:

```
boards_pkey                     unique (id)
boards_provider_token_site_key  unique (provider, token, site)   ← the identity
boards_active_lookup_idx        (provider, token) where active
boards_active_idx               (active) where active
```

**Why the identity includes `site`.** A Workday token is a TENANT, not a board.
Ochsner is one tenant running two career portals — `Ochsner` with 1,917 jobs and
`ochsnerphysician` with 346 — and they share no job ids [db]. 15 provider+token
pairs currently have more than one row [db].

### `jobs` — the postings

```
key                 text        primary key: provider:token:id
provider, board_token, company, title, location, country
remote_type, seniority, employment_type, department
salary_min, salary_max, salary_currency
posted_at, apply_url
family              text        the browsable category; NULL = out of scope
ai                  boolean
matched_skills      text[]
skill_score         integer
ghost_risk          numeric
specialization, specialization_reason, classification_version
adjacent            boolean
sector              text        education / government / health / nonprofit / research
quiet               boolean     GENERATED
first_seen_at, last_seen_at
closed_at           timestamptz NULL = still open
```

`quiet` is a stored generated column [db]. A posting is "quiet" when its title
carries none of the phrases people type into a search box.

Indexes [db] — note every one except two is **partial on `closed_at is null`**,
because the site only ever serves open postings:

```
jobs_pkey                        unique (key)
jobs_open_posted_idx             (posted_at desc nulls last) where closed_at is null
jobs_family_idx                  (family)                    where closed_at is null
jobs_country_idx                 (country)                   where closed_at is null
jobs_employment_type_idx         (employment_type)           where closed_at is null
jobs_adjacent_idx                (family, adjacent)          where closed_at is null
jobs_family_specialization_idx   (family, specialization)    where closed_at is null
jobs_classification_version_idx  (classification_version)    where closed_at is null
jobs_quiet_idx                   (family, posted_at desc)    where closed_at is null and quiet
jobs_sector_idx                  (sector, posted_at desc)    where closed_at is null and sector is not null
jobs_stack_idx                   (stack_of(matched_skills))  where closed_at is null
jobs_company_idx                 (company)                   ← not partial
```

**There is no index on `(key) where closed_at is null`** [db]. That matters for
the close-scan; see [The statement-timeout failure](#the-statement-timeout-failure).

### The other six tables

- **`exclusions`** — every title the classifier threw away, with a count.
  160,366 rows. Primary key `(reason, title)`. This is how "what are we
  discarding?" is answerable without storing a quarter of a million rows.
- **`crawl_runs`** — one row per crawl, with counts. Written by
  `db-feed.ts:527` and read by `crawl-db.ts:35` for the 45-minute guard [code].
- **`blocked_boards`** — `(provider, token, reason, blocked_at)`. 4 rows: two
  aggregators, two MLM recruiters [db].
- **`user_state`** — `user_id, skills, resume_chars, updated_at, first_name,
  last_name, resume_name, resume_size, resume_path`. 7 rows.
- **`job_events`** — `(user_id, job_key, seen, applied, at)`. 303 rows.
- **`app_seats`** — `(user_id, email, claimed_at)`. 3 rows.

### Database functions [db, `pg_proc`]

```
feed_page(21 args)        stable, security definer   ← the homepage feed
feed_facets(18 args)      stable, security definer   ← the filter counts
record_exclusions(jsonb)  volatile, security definer
stack_of(text[])          immutable                  ← used in an index
enforce_seat_limit()      volatile, security definer
seats_taken()             volatile, security definer
```

`feed_page` is the only route that goes through an RPC. Every other page reads
the table directly, and this is the one that is slow — see
[Open faults](#open-faults).

### Row-level security — verified, and one finding

RLS is enabled on all 8 tables [db]. Every policy is **SELECT only**, with one
exception [db, `pg_policies`]:

```
boards, jobs, crawl_runs, exclusions, blocked_boards   SELECT to anon+authenticated, USING (true)
user_state    "readable pre-auth"                      SELECT to anon+authenticated, USING (true)
job_events    "readable pre-auth"                      SELECT to anon+authenticated, USING (true)
app_seats     "own seat readable"                      SELECT to authenticated,       USING (user_id = auth.uid())
app_seats     "claim own seat"                         INSERT to authenticated,       WITH CHECK (user_id = auth.uid())
```

**There is no INSERT, UPDATE or DELETE policy on any other table.** All writes
therefore require the service key, which bypasses RLS. Confirmed by probe: an
anonymous `POST /rest/v1/user_state` returns **HTTP 401** [probe].

**FINDING — `user_state` is readable by anyone holding the publishable key.**
The policy is `USING (true)` for `anon`, and the table holds `first_name`,
`last_name`, `resume_name` and `resume_path`. An anonymous `SELECT` returns
**HTTP 206 with all 7 rows** [probe — count only; I did not read the personal
fields]. That key is not a secret: it is hardcoded as a default in
`src/db/supabase.ts:21` and ships inside the deployed Worker. `job_events` has
the same policy over 303 rows of per-user activity.

The policy name says "pre-auth", so it was presumably added so the app could
read state before sign-in. As written it exposes every user's row to every
visitor. Not previously recorded in `outstanding.md`.

### Statement timeouts [db, `pg_roles`]

```
anon           statement_timeout = 3s
authenticated  statement_timeout = 8s
authenticator  statement_timeout = 8s,  lock_timeout = 8s
service_role   (no per-role setting)
database default                = 2min
```

**[unverified]** Which of these actually applies to a crawler request is *not*
established. The crawler uses the service key, which has no per-role setting;
PostgREST connects as `authenticator` (8s) and then switches role. I tried to
provoke a timeout through PostgREST with the anonymous key using deliberately
expensive sorts and could not — the heaviest query I could construct returned in
2.5s [probe]. So the effective limit for the crawl is unknown, and the number
matters for the fix described below. Do not quote a figure for it.

---

## The code

### Layout

```
src/ats/          talking to vendors
  adapters/       one file per hiring system, 15 registered
  http.ts         request, timeouts, status → failure kind
  types.ts        AtsFetchError, FetchFailure
  normalize.ts    salary.ts  geo.ts  describe.ts  resolve.ts

src/corpus/       the pipeline
  boards.ts       merges the seed file with the registry
  board-store.ts  reads the registry, records crawl outcomes, retirement
  live.ts         runs a crawl: fetch, classify, shard, rate-limit
  db-feed.ts      writes jobs, closes withdrawn ones
  rate-limit.ts   one lane per vendor
  revival.ts      the rules for bringing a board back
  blocklist.ts  exclusions.ts  db-query.ts  snapshot.ts  types.ts

src/discovery/    finding new boards
  commoncrawl.ts  reads the URL index
  verify.ts       asks a board whether it is alive
  opendata.ts  careers.ts  companies.ts  probe.ts  …

src/taxonomy/     deciding what a posting is
  families.ts  specializations.ts  adjacent.ts  quiet.ts  sector.ts  unsorted.ts

src/cli/          21 entry points (see Workflows)
src/state/        auth, identity, per-user store
src/scoring/      fit.ts  saturation.ts
app/              Next.js: 4 pages, 12 API routes
```

### Vendor adapters

15 are registered in `src/ats/adapters/index.ts` [code]:

```
ashby  bamboohr  breezy  greenhouse  lever  personio  recruitee  rippling
smartrecruiters  socrata  teamtailor  ukg  usajobs  workable  workday
```

Twelve are hiring systems with boards in the registry; `socrata` and `usajobs`
are government feeds, and `breezy` has 21 registered boards [db].

**Every adapter answers one question: given a board, return its postings.**
Most route through `src/ats/http.ts`, which maps an HTTP status to a failure
kind via `failureKindFor` — 404 and 410 mean **gone**, everything else means
**refused**.

**Six adapters build their own `AtsFetchError` instead** — workday (3
occurrences), usajobs (2), lever, breezy, rippling, socrata [code]. I tested all
twelve ATS adapters by driving them against a fake 404 and 410 [probe]:

```
greenhouse  gone     lever      gone     ashby       gone
ukg         gone     recruitee  gone     teamtailor  gone
bamboohr    gone     personio   gone     workable    gone
smartrecruiters gone rippling   gone
workday     REFUSED  ← every status, including 404 and 410
```

**Workday alone can never be classified as gone.** `workday.ts:76` constructs
`new AtsFetchError(msg, 'workday', tenant, res.status)` without a failure kind,
so the constructor default — `'refused'` — applies [code]. Workday is 3,307 of
its 3,311 rows active and the largest source of jobs [db], and none of it can be
retired by any automatic path. This errs toward keeping live boards, which is
the intended direction, so it is recorded rather than fixed.

### Rate limiting

`src/corpus/rate-limit.ts`: one lane per vendor, each with its own concurrency
and gap. A refusal halves concurrency and doubles the gap immediately [code].
Defaults from `src/config.ts` [code]:

```
CRAWLER_CONCURRENCY   4
CRAWLER_DELAY_MS      250
CRAWLER_TIMEOUT_MS    20000
CRAWLER_MAX_FAILURES  5
```

---

## The crawl, step by step

`npm run crawl:db` → `src/cli/crawl-db.ts` [code]:

1. **Guard.** Read the most recent `crawl_runs.finished_at`. If it is less than
   **45 minutes** ago, exit — unless `--force`. This is what makes it safe for
   the schedule to declare six slots an hour.
2. **Build the list.** `loadBoardsAsync()` merges `discovered-boards.json` (1,437
   entries) with every `active` row from `boards`, keyed
   `provider:token:site` case-insensitively. The database wins on conflict.
3. **Shard.** Interleave by provider, then take every 4th board. Interleaving
   happens *before* sharding so the four shards do not all hit one vendor at
   once.
4. **Fetch and classify.** Each board goes to its adapter. Each posting is
   classified into a family; the description is read and then **discarded** —
   there is no description column.
5. **Count what is discarded**, before discarding it → `exclusions`.
6. **Write** the in-scope roles: `upsert` on `key`, 500 rows at a time, halving
   to a floor of 25 on a statement timeout.
7. **Close** postings that vanished — see below.
8. **Record board outcomes** → `recordCrawlOutcomes`.
9. **Insert** a `crawl_runs` row.

Measured from run 34243964434 [run]: four shards, ~6,304 boards each, ~5,600
answering, 14,258–15,059 roles written per shard, about 14 minutes wall clock
against a 40-minute workflow ceiling.

### Closing withdrawn postings

Only boards that **answered this run** may authorise closing, scoped by
`provider:token` [code, `closableBoards`]. Otherwise one failing board would
close its entire catalogue.

The scan itself pages through *every* open posting, 1,000 at a time, ordered by
key [code, `db-feed.ts:459`]. At 61,950 open jobs that is **62 sequential page
reads per shard**, and each of the four shards scans the whole table rather than
just its own boards.

---

## Retirement and revival

This is the part that has gone wrong twice, so it is documented in detail.

### What can retire a board, as of 8 Sep 2026

| Path | Automatic? | Can retire? |
|---|---|---|
| The hourly crawl | yes | **No. Never.** Passes `mayRetire: false` |
| `boards:verify` | weekly, 600 boards | Yes, on 404/410, five times running |
| Any Workday board | — | **No** — cannot be classified gone at all |
| `boards:dedupe` | manual only | Yes, for duplicate spellings |
| `block` | manual only | Yes |
| `boards-adopt` | in no workflow | Yes |
| `src/ingest/crawler.ts` | in no workflow | Yes, on a **single** 404 |

`recordCrawlOutcomes` has exactly two callers — `crawl-db.ts` and
`boards-verify.ts` [code, grep across `src/ app/ tests/`]. `mayRetire` defaults
to **false**, so a caller that does not think about it cannot retire anything.

**`boards:verify` has retired 0 boards in all five discovery runs on record**
[run: 34135635046, 34107431204, 34035258006, 34029347221, 34022686324 — each
logs `Recorded. 0 board(s) retired after 5 consecutive failures.`]. So before
the change above, the hourly crawl was doing all of it.

### Why the crawl no longer votes

It reads 25,000 boards an hour under vendor rate limits and cannot tell a bot
challenge from a closure. It has been wrong twice:

- **6 Sep**: 2,185 of 2,263 retired boards carried an HTTP 429 — a rate limit
  read as a closure.
- **8 Sep**: 44 more, on a Workday HTML challenge page served where JSON
  belongs. Probed live that day, **44 of the 81 boards retired for failing
  answered HTTP 200 with 7,871 jobs on them** [probe].

The crawl also no longer advances `consecutive_failures`. If it did, a board
would reach the careful pass already four strikes from death.

### The revival rule

`npm run boards:revive` no longer reads error text. It takes every retired board
that was not *deliberately* switched off, fetches it from its vendor at one
request a second, and brings it back only if it answers with a body that parses
[code, `src/corpus/revival.ts`].

- **A parse is required, not merely a 200.** `teamtailor:app`, `:discover` and
  `:integrations` are Teamtailor's own marketing subdomains; they answer 200 to
  `/jobs.json` with a landing page, which counts as zero jobs and is
  indistinguishable from a real empty board unless the parse is checked [probe].
- **Jobs are not required.** `workday:childrensplace` and `workday:rangersmlb`
  answered with `total=0` and are real employers between vacancies [probe].
- **Never reconsidered**: `duplicate spelling of X` retirements (330 boards, and
  all 330 were verified to point at a still-active board [db]) and anything in
  `blocked_boards`.

Run on 8 Sep [run 34243621215]: 411 retired → 330 duplicates and 4 blocked set
aside → 77 asked → **44 revived, carrying 7,901 jobs**; 33 stayed off (25 × 404,
3 × 422, one 410, two 302, three unparseable).

**What that actually delivered**, measured after the next crawl [db]: **377
postings stored**, all of them in a browsable family. Not 7,901. The crawler
only stores in-scope roles and these employers are a grocery chain, two hospital
systems and a medical school — SpartanNash reported 1,118 jobs and stored 0.
Corpus-wide, open jobs went 61,533 → 61,950.

---

## The workflows

Eight, all in `.github/workflows/` [code]. **Nothing deploys on push.**

| Workflow | Trigger | Runs |
|---|---|---|
| **crawl** | `cron: 7,17,27,37,47,57 * * * *` + dispatch | `crawl:db --shard N --of 4`, 4 shards, 40-min ceiling |
| **discover** | `cron: 23 4 * * 0` (Sun) + dispatch | `harvest:cc` per vendor, 11 vendors, `max-parallel: 2`, 120-min ceiling |
| **deploy-cloudflare** | dispatch only | `cf:deploy`, then uploads the write key as a Worker secret |
| **revive** | dispatch only | `boards:revive` or `boards:dedupe`, `dryRun` defaults to **true** |
| **seed** | dispatch only | `boards:seed` |
| **block** | dispatch only | `block` add / remove / list |
| **backfill** | dispatch only | `backfill:spec` |
| **netlify-retire** | dispatch only | deletes the old Netlify site; requires typing the name back |

Six declared crawl slots an hour; GitHub fires roughly 6% of them
[unverified — from `parked.md`, not re-measured here]. The 45-minute guard makes
over-triggering safe.

**`boards:verify` runs inside `discover`, not on its own** — and only in the
`greenhouse` shard, guarded by `if: matrix.provider == 'greenhouse'`, with
`--limit 600` [code]. So it examines 600 boards a week. Against 25,205 active
boards that is roughly 42 weeks to cross the registry once.

### Discover's vendor list, and two gaps

```
greenhouse  workday  ashby  lever  smartrecruiters  workable  personio
bamboohr    ukg      recruitee  teamtailor
```

Eleven. **Rippling and Breezy are absent**, though both have working adapters
and registered boards (4 and 21) [db]. Rippling additionally has no `endpoint()`
case in `src/discovery/verify.ts` [code], so a Rippling board returns verdict
`unknown` forever — it can never be confirmed alive or dead.

The file's own comment names those two: *"These five have working, proven
adapters and 310 boards between them from the original file."* Counting the seed
file by provider [code], smartrecruiters 61 + workable 22 + personio 202 +
breezy 21 + rippling 4 = **exactly 310**. The comment is precise; the matrix
never caught up with it.

---

## The site

Cloudflare Worker, built with OpenNext. It reads Postgres directly, so a crawl
needs no rebuild — that is what makes hourly crawling affordable.

Pages: `/`, `/quiet`, `/institutions`, `/account`, `/admin`, `/signin`.

API routes [code]: `feed`, `quiet`, `institutions`, `me`, `state`, `profile`,
`profile/name`, `profile/resume-file`, `auth/session`, `auth/signin`,
`auth/signout`, `admin`.

Measured 8 Sep after deploy [probe]:

```
/                    200    689ms
/quiet               200    113ms
/institutions        200    493ms
/api/feed?limit=20   200   1978ms
```

Anonymous write attempts, all correctly refused [probe]:

```
POST   /api/profile/name         401  {"error":"sign in first"}
POST   /api/profile/resume-file  401
DELETE /api/profile/resume-file  401
GET    /api/admin                404  (deliberate)
```

`POST /api/profile` is **not** in that list: it is scoped to an anonymous
visitor cookie by design and writes that visitor's own row [code].

The `total` field in the feed response is `facets.scanned` — postings scanned,
not open jobs [code]. It reads far larger than the corpus and that is correct.

---

## Corrections to existing documentation

Four statements in the current docs and comments are wrong. Each was checked.

**1. `state-of-play.md`: the statement-timeout crash is fixed.** It lists two
failures "on commits before the `a491821` fix. Every run since is green." A
third failed on **8 Sep at 01:36, on current HEAD `4f0e5a5`**, after that fix
[run 34176380324].

**2. `outstanding.md §1`: the HTML challenge page is a live retirement risk.**
It is not, and has not been since `7f354dd` landed on 7 Sep 05:55 UTC. Driving
the real Workday adapter against a 200 + HTML body now yields
`failure: 'refused'` [probe]. All 46 boards were last crawled before that commit
[db]. The 44 were historical damage, not an ongoing leak.

**3. `src/db/schema.sql` has drifted from the database.** It declares
`unique (provider, token)` and never mentions `site`. The live database has
`boards_provider_token_site_key` on `(provider, token, site)` and a generated
`site` column [db]. A database built from `schema.sql` alone would hold one
career site per employer — the bug the migration exists to fix.

**4. `discover.yml`'s comments are accurate, and I was wrong to call them
stale.** "so four run in parallel" was written in `ee62e1e` when the matrix held
exactly four vendors, and states the design principle — shard by vendor, not by
count. `max-parallel: 2` arrived later in `7f354dd` with its own comment
directly beneath giving the current number [code, git history].

---

## Open faults

Ranked by what they cost. None is fixed.

### The statement-timeout failure

Three crawl runs have died this way [run: 34176380324, 34131971944,
34043214452]. The error is always the close-scan:

```
crawl failed: supabase close-scan failed: canceling statement due to statement timeout
```

**Two explanations I tested and ruled out:**

- *Not OFFSET pagination.* Timed at increasing offsets, pages took 2.7s, 3.1s,
  1.2s, 800ms, 713ms, 731ms, 390ms — faster, not slower [probe].
- *Not read contention.* Four concurrent scanners averaged **293ms** per page
  against **388ms** solo — a multiplier of 0.8× [probe].

**What the timeline shows** [run 34176380324]:

```
01:36:04  shard 3 finishes crawling — 12,855 roles, the smallest load
01:36:35  shard 3 FAILS on the close-scan
01:36:40  shard 0 finishes writing 15,591 roles
```

Shard 3 had the least to write, so its upsert finished first and its close-scan
ran straight into shard 0's bulk write. It is a large read colliding with a bulk
write on the same table — one carrying a stored generated column and twelve
indexes [db].

**The fix already exists and is not applied here.** `isTransientWriteError` in
`db-feed.ts:281` matches this exact message and drives a halving retry on the
*upsert* path. The close-scan calls neither — it throws on the first timeout
[code]. Same shape as the discovery bug in `outstanding.md §6`: the write path
retries, the read path does not.

**What is actually lost:** the upsert runs *before* the close-scan, so the
roles were already saved. What is lost is that shard's closing pass, plus a
false failure that opens an issue.

**Second, larger inefficiency:** all four shards scan all 61,950 open postings
when each needs only its own boards — 248 page reads per run where ~62 would do.

### `user_state` and `job_events` are publicly readable

See [Row-level security](#row-level-security--verified-and-one-finding). Not
previously recorded anywhere.

### Retired boards are still crawled

19 boards that are retired in the registry are still present in
`discovered-boards.json`, and the merge re-adds them because
`readActiveBoards()` returns only active rows — so the merge cannot tell
"retired" from "not in the registry" [code]. Seven of them fail every run and
sit at 8 and 9 consecutive failures, above the threshold of 5 [db].

This is also why deleting that file is dangerous: `boards-adopt.ts` records that
it would drop 1,287 boards out of the crawl and close their jobs [code].

### `/api/feed` is the slowest route

p50 ~1.85s across 8 uncached requests, against 113–689ms for every other page
[probe]. It is the only route going through the `feed_page` RPC. Uninvestigated.

### Rippling and Breezy are not discovered

Above. Rippling additionally cannot be verified at all.

### The service key should be rotated

Recorded in `outstanding.md §8`: it was pasted into a chat on 7 Sep. Not done.

---

## What I could not verify

Listed so nobody mistakes silence for confirmation.

- **The effective statement timeout for the crawler.** Role settings are known
  [db] but which applies through PostgREST under the service key is not, and I
  could not provoke a timeout to find out.
- **The claim that GitHub fires ~6% of declared cron slots.** Taken from
  `parked.md`; not re-measured.
- **Whether anything still reads `data/feed-snapshot.json`** (5.6MB, last
  written 1 Sep) or `discovered-boards.json` in a workflow other than the crawl
  merge.
- **The Institutions page accuracy figure (~30%).** From `parked.md`, not
  re-tested here.
- **Whether the 3 Teamtailor subdomains were ever real boards.** They answer
  with marketing pages today; their history is unknown.

---

## Regenerating the evidence

```
node docs/evidence/collect.mjs
```

Read-only — it uses the publishable key, so it cannot write. It re-measures the
corpus, the registry, seed coverage, the live site and recent Actions runs.

The database figures in this document came from direct SQL against the live
project rather than from that collector, because the collector reads through
PostgREST and cannot see indexes, policies or role settings.
