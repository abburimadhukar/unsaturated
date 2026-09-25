# State of play — Unsaturated, 17 September 2026

Where the project actually is. First written 7 Sep; the headline numbers, the
platform table and the "verified working" table were re-measured on **17 Sep**
against the live database and site. Raw output is in
[evidence/](evidence/) (`2026-09-17-*.json`; the 7 Sep files are kept for
comparison). The build history below is a record and was not re-measured.

Three companion documents:

| Document | What it holds |
|---|---|
| [parked.md](parked.md) | Work deliberately set aside, and what it would take to pick up |
| [outstanding.md](outstanding.md) | Faults and gaps with no decision attached — ranked, with evidence |
| [handoff.md](handoff.md) | Phase-by-phase prompts for picking any of it up in a fresh session |
| [corpus-growth.md](corpus-growth.md) | Where more job boards can come from, and what is already ruled out |

---

## In one paragraph

Unsaturated reads jobs directly from employers' own hiring systems — no job
board, no aggregator, no scraping of listings sites. It crawls 29,619 company
career boards across 16 hiring platforms, classifies each role, and serves the
ones nobody else is surfacing. The crawl is scheduled hourly but GitHub runs it
about every 3–4 hours. The site is live, the corpus holds **84,637 open
postings**, and the whole pipeline runs on free infrastructure:
GitHub Actions for the crawl, Cloudflare Workers for the site, Supabase for the
database.

---

## The numbers, 17 September

```
jobs                   150,426 rows ever seen        (7 Sep: 81,014)
  open                  84,637                                (60,750)
  closed                65,789                                (20,264)
  in a real family      45,455   ← the browsable feed         (32,643)
  unsorted              39,182                                (28,107)
  marked "quiet"        61,614                                (44,349)

boards                  30,104 rows                           (25,572)
  active                29,619                                (25,161)
  retired                  485                                   (411)
  at zero failures      29,587   (99.9% of active)            (25,010)

hiring systems with boards  16                                    (12)
```

Live: **https://unsaturated-jobs.rarejobs.workers.dev**

Freshness — how long ago each open posting was last confirmed to exist. The
first line is 0 because the last crawl had finished about three hours before
the measurement, which is the cadence problem in [parked.md §5](parked.md):

```
not seen in 1 hour      84,637   (all — no crawl in the last hour)
not seen in 6 hours      5,145
not seen in 24 hours     2,385
not seen in 48 hours     1,844   ← 1,026 Workable, 712 stale copies;
                                   see outstanding.md §1 and §2
```

Evidence: [evidence/2026-09-17-corpus.json](evidence/2026-09-17-corpus.json)

### Where the jobs come from

17 Sep *(SQL)*:

| Platform | Boards | Active | Open jobs |
|---|---:|---:|---:|
| Workday | 4,108 | 4,104 | 37,987 |
| Greenhouse | 6,020 | 5,970 | 14,636 |
| Ashby | 3,813 | 3,563 | 8,332 |
| SmartRecruiters | 1,284 | 1,257 | 6,482 |
| Oracle Cloud | 764 | 642 | 4,456 |
| Workable | 3,051 | 3,051 | 2,518 |
| Lever | 1,974 | 1,969 | 2,451 |
| Rippling | 1,190 | 1,190 | 2,367 |
| UKG | 1,771 | 1,747 | 2,291 |
| Teamtailor | 870 | 869 | 1,159 |
| Recruitee | 740 | 740 | 800 |
| BambooHR | 2,921 | 2,919 | 736 |
| Personio | 1,564 | 1,564 | 388 |
| Socrata | 1 | 1 | 25 |
| Breezy | 21 | 21 | 9 |
| Eightfold | 12 | 12 | 0 — stored 17 Sep, not crawled yet |

Workday is still a seventh of the boards and nearly half the jobs. Oracle,
connected 15 Sep, is already fifth. Rippling went from 4 boards to 1,190.
Oracle's 122 retired rows are duplicate sites of employers still crawled — see
[corpus-growth.md](corpus-growth.md).

---

## What was built, in order

### Round 1 — the classifier was wrong in five ways

Roles were landing in the wrong family, or in no family at all. Each of these
was found by reading the actual postings in the Unsorted queue, not by guessing:

- **Aerospace systems engineers** were being filed as cloud roles, because
  "systems" matched a cloud rule. (`4bca8a0`)
- **Factory production engineers** likewise. (`2e3301f`)
- **Generic HR** was landing in HRIS. The HRIS rules were rebuilt so a vendor
  name counts anywhere, "systems" only in the core, and "management" only as
  adjacent. (`45a0310`, `7e491fa`)
- **GTM, solutions and devrel engineers** were being excluded outright by rules
  meant to catch sales roles. Recovered. (`1a9709a`)
- **Cloud roles** sitting in the review queue, recovered. (`7af48bd`)

An `adjacent` flag the crawl had been computing was never written to the
database at all — the column existed, nothing filled it. (`1655e56`)

### Round 2 — three pages and an identity

- **Quiet Roles** (`d8459c3`): the jobs nobody is searching for. A posting is
  "quiet" when its title carries none of the magnet phrases everybody types into
  a search box. This is a stored generated column, which matters later — see
  [parked.md §2](parked.md).
- **Institutions** (`8aea66f`): universities, hospitals, government, nonprofits,
  research labs. **This page is roughly 30% accurate and is the single largest
  quality problem in the product** — see [parked.md §1](parked.md).
- **Accounts** (`6adc53b`): a name, an account page, a colour per family.
- **A light theme** and a separated accent/danger palette (`8ee025c`), then the
  Quiet accent retuned from green to teal (`d22fd38`).

### Round 3 — the crawler was retiring live companies

The most damaging bug in the project's history. A board that **refused** us — a
rate limit, a 429, a server error — was being counted the same as a board that
was **gone**. Five strikes and it was deactivated.

```
2,185 of 2,263 retired boards carried an HTTP 429
   16 were genuinely 404
```

Every one sampled afterwards answered 200 with jobs still on it. Fixed by
splitting refusal from death and giving each vendor its own lane with its own
discovered rate limit (`7f354dd`, `983ed34`), then making the diagnostic name
who was refusing (`6005d47`).

The weekly re-check that retires genuinely dead boards had itself broken and was
repaired (`2346cd2`).

### Round 4 — more hiring systems

BambooHR and UKG (`f8a19c8`), Recruitee and Teamtailor (`f7ea4f4`), the UKG host
carry-over so a board on `recruiting2` is not looked for on `recruiting`
(`c32e9f4`), and SmartRecruiters' second domain (`461c2de`).

Common Crawl discovery was fetching the entire catalogue eleven times per run —
once per platform — and being throttled into returning a different partial slice
every time. Fixed in `8aea66f`. Before that fix, **we had never once seen a
complete catalogue.**

### Round 5 — 7 September

**The name and resume bugs.** Both reported by the owner. Both the same root
cause, and it is worth stating precisely because it was invisible:

`user_state.updated_at` is `NOT NULL DEFAULT now()`. A column default applies
only when a statement **omits** the column. Sending an explicit `NULL` is not
the same thing — Postgres stores the NULL, hits the constraint, and rejects the
row. Three of the five writers (`setProfileName`, `setResumeFile`,
`clearResumeFile`) spread a profile whose `updatedAt` was null and sent it.

So every name and every resume record failed **for anyone who did not already
have a row** — which is exactly the people it had to work for. Someone signing
up is named before they have a row. And `/api/me` deliberately swallows a name
failure so a name cannot break the page, so nothing anywhere said so.

Reproduced against production before fixing:

```
23502 null value in column "updated_at" of relation "user_state"
      violates not-null constraint
      Failing row contains (_verify_scratch, {}, 0, null, Ada, Lovelace, ...)
```

Fixed by making `userStateRow()` the only place a timestamp is stamped, so no
writer can forget again (`ebdcf59`). Deployed 7 Sep, run 34120593054.
**Verified live**: `user_state` now holds `Madhukar Abburi`, written 12:16.

Two resume files had been left orphaned in the storage bucket by the failed
writes — uploaded, then nothing pointing at them, so nobody could see or delete
them. Deleted. The bucket is now empty and verified private.

**Every board in the seed file put into the registry.** `discovered-boards.json`
held 1,437 verified boards; the registry was only crawling some of them. All
1,437 are now registered, 1,422 active (`79f8378`, `4f0e5a5`).

**One employer can now keep all of its career sites** (`13021ec` + migration
`2026-09-07-workday-sites.sql`). Workday addresses a board as
`{tenant}.{wdN}.myworkdayjobs.com/{site}` and one tenant hosts many sites. The
unique constraint was on `(provider, token)` alone, so storing a second site
overwrote the first. 14 tenants genuinely hold two live sites, and in several
cases we had been keeping the small one:

| Tenant | We had | We were missing |
|---|---|---|
| Cleveland Clinic | UK site, 22 jobs | main site, **2,107** |
| Mass General Brigham | physicians, 78 | main, **2,000+** |
| Ochsner | physicians, 346 | main, **1,917** |

Honest caveat, measured rather than assumed: most multi-site tenants are
hospitals, so most of what was recovered is nursing. Of Cleveland Clinic's 2,107
postings, 1,794 have no tech family, 286 are explicitly clinical, and **exactly
2 are in scope**. The real gains are `medtronic` (127 open in scope), `gilead`
(31), `nshe` (6).

**A slow write no longer throws away a whole shard's crawl** (`a491821`). A
shard that had crawled 5,608 boards and collected 15,746 roles discarded all of
it because one 500-row statement timed out. Now the chunk halves and retries
down to a floor of 25.

**A migration runner** (`99290f6`, `npm run migrate`), so schema changes stop
being copy-paste into a web SQL editor.

---

### Round 6 — 8 to 17 September

Recorded in the commit history; the headlines:

- **Retirement taken out of the hourly crawl** (`c5589c7`), revival asks the
  board rather than reading its message (`697de49`), and a board no longer
  carries a neighbour's error text (`f645ce0`). The 46 wrongly retired Workday
  companies are all back.
- ~~**Resume tailoring** (12–15 Sep)~~ — **removed 25 Sep 2026**, not in use.
  The stored CV text went with it; skills extraction for Best match stayed.
- ~~**Job vectors** for matching (11 Sep)~~ — **removed 25 Sep 2026.** Never
  read by anything and ~200 MB, 40% of a database at its free-plan ceiling.
  See migrations/2026-09-25-remove-tailor-and-matching.sql.
- **Profiles made private** (`d855585`, `9035192`).
- **Rupees no longer outrank dollars** in "highest paid" (`2e68b7c`).
- **Oracle Cloud and Eightfold connected**, the Internet Archive added as a
  second discovery index (15–16 Sep) — [corpus-growth.md](corpus-growth.md).
- **An employer's career sites stay in one crawl shard** (`1a00f28`); closures
  on multi-site employers fell from 7,041 in one run to 65.
- **Crawl close-scan timeouts** fixed with an index and a longer retry wait
  (`ddcaef0`, 17 Sep), awaiting a green crawl to prove it.

---

## What is verified working, right now

Re-checked 17 Sep.

| Check | Result | Evidence |
|---|---|---|
| Live pages | 7 of 7 answered 200 — but `/api/feed` took 9.0 s | [live-site.json](evidence/2026-09-17-live-site.json) |
| Bad input rejected | 6 of 6 answered 400 | same file, `validation` |
| Anonymous writes refused | 401 on all three profile routes | same file, `auth_gates` |
| Test suite | **1,331 tests, 1,315 pass, 0 fail** (16 skipped) | `npm test`, 17 Sep |
| Typecheck | clean | `tsc --noEmit` |
| Crawls | 21 of the last 24 green; the 3 failures are the close-scan timeout now fixed | [pipeline.json](evidence/2026-09-17-pipeline.json) |
| Discovery | last 2 runs green | same file |
| Every seed board registered | **1,437 of 1,437**, 1,429 active, none missing | [seed-coverage.json](evidence/2026-09-17-seed-coverage.json) |
| Double-crawled boards | **0** | [boards.json](evidence/2026-09-17-boards.json) |
| Retired on an HTML challenge page | **0** (was 46) | same file |
| Duplicate postings we caused | **712 stale copies** — the largest open fault | [outstanding.md §1](outstanding.md) |

### On the duplicate figure

A naive scan finds 2,351 open postings sharing a company, title and location.
**2,343 of those are the employer's own doing** — one title posted under several
requisition IDs, which is real and must not be collapsed. Only **8** come from
us holding two boards for one company:

- ClickHouse moved from Greenhouse to Ashby; the Greenhouse rows are stale.
- `recruitee:foodlabs` and `recruitee:jobsatlanticvc` are the same board under
  two tokens.

Both are listed in [outstanding.md](outstanding.md).

*17 Sep:* that figure is no longer 8. The employer-side repeats are now 5,036,
and on our side 712 postings are stale copies stored under a retired lowercase
spelling of a live token — [outstanding.md §1](outstanding.md).

---

## How it ships

Nothing deploys on push. Everything is a manual dispatch:

```
gh workflow run deploy-cloudflare.yml   # build + deploy the site
gh workflow run crawl.yml               # 4 shards
gh workflow run discover.yml            # 11 platform shards
gh workflow run backfill.yml            # reclassify existing rows
gh workflow run revive.yml              # bring back wrongly-retired boards
```

Migrations in `src/db/migrations/` are applied by hand, or now with
`npm run migrate` given a `DATABASE_URL`. **Applying the migration before
deploying is not optional** — the code expects columns the database would not
yet have.

The Supabase write key lives in GitHub Actions secrets and, after deploy, in the
Worker as a runtime secret. It is deliberately not in any local `.env`, so a
local command that writes falls back to the read-only key and RLS refuses it.

---

## The rules this product is built on

Worth stating, because several of the parked decisions turn on them.

1. **Nothing is invented.** No fabricated scores, no guessed salaries, no
   made-up employer detail. A missing value shows as missing.
2. **Freshness is the product.** The one job posted in that hour is the one that
   counts. This is why board scheduling by tier was proposed and rejected.
3. **A refusal is not a death.** Written into the crawler after it cost us 2,185
   live boards.
4. **Read the postings before changing a rule.** Every classifier fix above came
   from reading real adverts. The Institutions page is 30% right precisely
   because it was validated against Cornell and startups and never against an
   ordinary employer.
