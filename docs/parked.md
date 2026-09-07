# Parked work — what was set aside, and how to pick it up

Written 7 September 2026. Everything here was measured, not guessed. The numbers
are kept so nobody re-derives them, and each item says what is already known,
what the fix direction is, and what would have to be decided.

Corpus growth lives separately in [corpus-growth.md](corpus-growth.md).

---

## 1. Institutions page — the sector rules are ~30% right

**Parked by the owner, 7 Sep. This is the largest quality problem in the
product.** The page is live and mostly wrong.

867 roles carried a sector when measured. Reading the employers behind them,
the majority are not institutions:

| Sector | Rows | Genuinely institutions | Not institutions |
|---|---|---|---|
| education | 307 | WGU, Harvard, NJIT, ASU, Embry-Riddle | Nelnet, ASML, Synechron, M&T Bank |
| government | 299 | Oklahoma.gov | NBCUniversal, DXC, Mistral AI, Muon Space |
| health | 125 | ARUP Laboratories | McKesson, GE Healthcare, Edwards, BMS |
| nonprofit | 85 | SF Campus for Jewish Living | Version 1 (26 roles), CapTech, Oaktree, Quicken Loans |
| research | 51 | NREL, LLNL | Vertex, Intel, Nvidia, Flexport |

### Reproduced directly

Six ordinary corporate adverts, none an institution. Five were misclassified:

```
government   an advert naming the city its office is in
null         a medical device company              ← the only correct one
nonprofit    an IT consultancy calling itself mission-driven
government   a defence contractor selling to federal agencies
research     a pharma company with a research programme
education    a bank that recruits from universities
```

### Why it happened

The rules were validated against **Cornell**, which writes unmistakably like a
university (6 of 6 correct), and against **health-tech startups**, which the
vendor guard correctly refuses (17 of 17). An ordinary large employer was never
tested — and that is where every false positive lives.

The patterns match language any company uses. `City of Austin` appears in a
location line. `patient care` is what a device maker sells. `our mission` is on
every consultancy's careers page.

### What already works — keep it

- **The `VENDOR` guard**, which refuses anyone talking about their platform,
  customers, partners, funding round or calling themselves a startup. 17 of 17
  health-tech startups correctly refused, including a crypto foundation.
- **Requiring a description.** No text means no verdict, never a guess.
- **The name as a tie-breaker only.** Matching employer slugs returns
  `alpacahealth`, `bayesianhealth`, `ambiencehealthcare` — startups, not
  hospitals. A name must never establish a sector alone.

### The fix direction

The rules test whether an advert **mentions** an institution. They need to test
whether the employer **is** one — the same distinction the vendor guard already
draws for health-tech, applied to all five sectors.

Concretely: an institution describes ITSELF (`our patients`, `our students`,
`the University`, `501(c)(3)`); a vendor describes its MARKET (`City of Austin`
as a location, `patient care` as a product, `we recruit from universities`).

**File:** `src/taxonomy/sector.ts`. **Tests:** `tests/sector-and-admin.test.ts`.

**Before shipping any change, test against ordinary employers** — a bank, a
consultancy, a pharma company, a defence contractor, a device maker. That is the
test set that was missing, and it is why this shipped wrong.

### Decision needed

Whether to take the page down while it is fixed. It is currently misleading
enough that I would.

---

## 2. Quiet roles — a 1.4% leak, and a trap in fixing it

**Parked by the owner, 7 Sep.** Small, and the page is otherwise sound.

14 leaks in 1,000 sampled quiet titles. Every one is a "full stack Java"
variant:

```
Full Stack Development (Remote - Canada)
Tech Lead - Java fullstack (Angular)
SSR Fullstack Java / Angular
Full Stack Java Engineer
Manager, Engineering - Java full-stack
Associate Director, Full-stack Forward Deployed Engineer
```

`MAGNET_TITLES` holds `full stack engineer` and `full stack developer` but not
bare `full stack` or `fullstack`, so anything phrased around them slips through
onto a page that promises the opposite.

### The trap — read this before editing the list

**`quiet` is a STORED GENERATED COLUMN.** Postgres will not let you alter a
generated column's expression. Changing `MAGNET_TITLES` means:

1. Edit `src/taxonomy/quiet.ts`
2. `npm run quiet:sql` to regenerate the migration
3. **Drop and re-add the column** — an `alter … add column if not exists` will
   silently do nothing because the column already exists, and the site will keep
   filtering on the old list with nothing anywhere saying so
4. Re-apply the index

A test compares the checked-in SQL against the TypeScript on every run, so step
2 cannot be forgotten. **Step 3 has no such guard** and is the one to get wrong.

**Also worth widening while in there:** bare `Architect`, which appears 19 times
unqualified and is genuinely ambiguous, and the enterprise-platform titles
(`Salesforce Developer`, `SAP Architect`) if item 3 below is ever built.

---

## 3. Enterprise platforms as a family

**Parked earlier in the session.** Found sitting in the Unsorted review queue:

```
salesforce   228
sap          171
dynamics     115
servicenow    98
```

These are real technical roles with no family of their own. They currently land
in `software` when a rule catches them and in `unsorted` when nothing does,
which is why the same job appears in different places depending on its title.

Would need: a fifth family or a specialization, its own colour token in both
themes, and a decision about whether `Salesforce Developer` counts as a magnet
title on the Quiet page.

---

## 4. AI match score — designed, measured, parked before any code

**Parked by the owner, 7 Sep, after the analysis below. Nothing is built.**

The ask: with a resume on file, score every job against it with an AI and show a
small badge on the card. Remove the Newest / Best match / Salary selector.

### Two blockers you would hit on the first day

**Job descriptions are not stored, and never have been.** The crawler reads each
one, classifies the role from it, and discards it. There is no `description`
column — `2026-09-06-sector.sql` says so out loud. So today there is literally
nothing for an AI to read.

**Resume text is not stored either**, deliberately: only the extracted skills
and a character count. The uploaded file exists as of 7 Sep, but the text does
not.

Both are fixable cheaply. Neither is optional.

### Why the current "Best match" deserves replacing

It is a set overlap between the person's skills and skills pulled from the job.
Measured 7 Sep on the live corpus:

```
60,413  open jobs
39,471  of them (65%) have an EMPTY matched_skills array
32,669  open and in a real family — the browsable feed
76,688  rows in `jobs` altogether
10,841  new jobs arrived in a single day
```

So "Best match" silently cannot rank two thirds of the corpus, and nothing on
the page says so.

### The constraint everything bends around

Matching is per PERSON × JOB. 32,669 browsable jobs across 4 seats is ~130,000
combinations, growing by ~10,000 jobs a day.

OpenRouter's free models allow roughly **20 requests a minute and 50 a day**,
rising to about **1,000 a day** once $10 of credits has been bought once.
**Confirm this against the account before building** — 50/day and 1,000/day are
different products.

That is a budget of 50–1,000 AI calls per day for everybody. Scoring every job
for every person is off by four orders of magnitude.

**The whole design follows from one rule: never call the AI per job. Call it
per screenful, and never for the same job twice.**

### The architecture, in three parts

**1. Give the AI something to read.** One new column, `match_digest` — ~500
characters of requirements distilled from the description DURING THE CRAWL,
which is the only moment the text exists. The crawler already holds it and
already trims to 4,000 characters to classify, so this is nearly free.

Two things make it cheap: ~30 MB across the open corpus, and — the useful part —
**it backfills itself**. The crawler re-reads every board every hour and upserts
every job it finds (see `toJobRow`), so the live corpus fills in within about
two hours of shipping. No backfill job, no migration script.

**2. Give it something to compare against.** ONE AI call when a resume is saved,
producing an ~800-character profile: level, years, core skills, domains, tools.
Stored on `user_state`.

This keeps the existing privacy rule intact — still no CV text in the database,
only a summary — and makes every later call small, because the resume travels as
800 characters rather than 9,522.

**3. Score a screenful, cache it forever.** A new table:

```
job_match (user_id, job_key, score, note, model, scored_at)
```

The feed renders 50 jobs, looks up the cache, and for whatever is missing makes
ONE call carrying the resume profile plus up to 50 job digests, answering with
50 scores and a short reason each. Valid until the resume changes — bump a
`resume_version` and the cache invalidates.

The budget works out comfortably. One call per 50 unscored jobs: at 1,000
calls/day that is 50,000 job-scorings a day against a browsable corpus of
32,669, so **one day's budget covers everything, permanently.** At 50 calls/day
it is 2,500 a day — slower, still accumulating.

Budget spent, model down, or a 429: the card falls back to the existing skill
number and says "not scored yet". The feed never blocks on the AI and never
shows an invented figure — the same rule the rest of this product follows.

### The limitation, which must be said out loud

**The score can only rank jobs already loaded.** It cannot sort all 32,669 by
fit, because that would mean scoring all of them first. What it gives is a
trustworthy number on every job someone looks at — NOT "show me my best matches
across the whole site".

Corpus-wide ranking is a different technique: embeddings, one vector per job
computed once, cheap similarity against the resume, zero per-user AI calls.
**OpenRouter is chat-only and serves no embeddings endpoint**, so that would
need a second provider. Worth knowing before anyone promises it.

### Build order

Stopping after step 1 leaves the site working exactly as it does now, which is
why it goes first.

1. Plumbing, no AI — the table, the route, the badge, falling back to the local
   score. Proves the display and the caching before a token is spent.
2. The `match_digest` column. Ship it, watch it fill.
3. Resume profile on upload.
4. Turn the AI call on.
5. Remove the sort selector.

### Decisions still open

- **The OpenRouter key must go in as a Worker secret**, the way
  `SUPABASE_SECRET_KEY` does in `deploy-cloudflare.yml`. Not in the repo, and
  not pasted into a chat.
- **Credits bought or not** — decides 50/day vs 1,000/day.
- **Which free model.** Availability rotates, so this should be a config value
  with a fallback list rather than a hard-coded name.
- **What the score means.** Proposed: 0–100 for fit, plus a five-word reason.
- **The "minimum match" dropdown.** It is built on the old overlap calculation.
  Re-point it at the AI score rather than delete it — a "70%+ only" filter is
  worth much more with a real number behind it.
- **Newest stays** as the fixed order when the selector goes. It is the database
  default and freshness is the product.

### The older intent, still unbuilt

The original idea here was a SKILLS GAP: showing what a person is missing for a
role, not only what they match. The scoring work above produces exactly the
evidence that needs, so it is the natural second feature rather than a separate
one.

---

## 5. Colour and profile detail

**Both parked earlier**, after the specific problems were fixed.

- **Colour**: the accent/danger clash was fixed and four page identities exist
  (feed orange, quiet teal, institutions blue, account violet), each checked for
  contrast in both themes. Anything further is preference, not correctness.
- **User details**: applied and seen counts are shown. Anything beyond that —
  saved searches, per-family activity, application history — was deferred.

---

## Not parked, just not done yet

These have no decision attached. They are simply outstanding.

| What | Status |
|---|---|
| **`/api/feed` returned 503** while `/quiet` and `/institutions` answered 200 in the same second | Found 7 Sep, uninvestigated. It is the only one going through the `feed_page` RPC rather than reading the table directly, so it is the slowest and likeliest to hit a statement timeout. **User-facing — the homepage showing no jobs.** |
| **96 boards at 3+ consecutive failures** | Harmless now that refusals cannot retire anything, but the reason is unknown. |
| **A crawl shard died on `canceling statement due to statement timeout`** during a job upsert, once, 6 Sep | Possibly the same root cause as the 503. |
| **The name and resume fix is on `main`, undeployed** | `ebdcf59`, 7 Sep. `user_state.updated_at` is NOT NULL and three writers sent it as an explicit NULL, so every name and every resume record was rejected for anyone without a row. Verified fixed against production; **the live site still has the bug until someone deploys.** Two of the owner's resumes are still sitting orphaned in the `resumes` bucket, uploaded 6 and 7 Sep, with nothing pointing at them. |
| ~~**The `resumes` storage bucket**~~ | **Answered 7 Sep: it exists and is correctly private.** An anonymous upload to `resumes/` is refused with `new row violates row-level security policy`, where a bucket that did not exist answers `Bucket not found`. Uploads were failing for an unrelated reason — see `userStateRow` in `src/state/store.ts`. |

---

## Settled — closed, not parked

Do not reopen these without new evidence.

- **Workable is a Cloudflare bot challenge**, not a rate limit. `cf-mitigated:
  challenge`, `server: cloudflare`, `<title>Security challenge</title>`, and
  none of the rate-limit headers its own API documents. Slowing to one request
  every four seconds still drew ~700 refusals per shard. See
  [corpus-growth.md §0b](corpus-growth.md).
- **Board scheduling by tier** — crawling low-yield boards less often. Proposed
  and rejected on the right grounds: freshness is the product, and a role found
  five hours late is the role someone else already applied to. Per-vendor lanes
  solved the underlying problem without skipping anything.
