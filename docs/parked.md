# Parked work — what was set aside, and how to pick it up

Written 7 September 2026, updated the same evening, **re-checked 17 September**
(what changed is marked *17 Sep* in each section; §1–3 and §6 are unchanged —
no commit since 7 Sep touches the sector, quiet or family rules). Everything here was
measured, not guessed. The numbers are kept so nobody re-derives them, and each
item says what is already known, what the fix direction is, and what would have
to be decided.

**This file holds work that was deliberately set aside.** Its companions:

| Document | What it holds |
|---|---|
| [state-of-play.md](state-of-play.md) | Where the project is, what was built, what is verified |
| [outstanding.md](outstanding.md) | Faults with no decision attached — ranked, with evidence |
| [corpus-growth.md](corpus-growth.md) | Where more boards can come from, and what is ruled out |
| [evidence/](evidence/) | The raw measurements behind every number in all four |

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

**Parked by the owner, 7 Sep, after the analysis below.**

*17 Sep — part of the groundwork now exists, by a different route than the
design below.* On 11 Sep a vector approach was started instead of per-screen AI
calls (`a41bd59`, `f0f9c0d`, `01ada76`, `346c7cc`, `62db83e`):

```
job_embedding          74,231 job vectors (bge-small, Workers AI) — filled by the crawl
user_state.resume_text      stored now (2026-09-12-resume-text.sql)
user_state.resume_embedding column exists — 0 resumes embedded
```

Nothing on the site uses the vectors yet: no resume has one, and the feed still
sorts by the old overlap. So the first blocker below is solved differently (the
job side is embedded during the crawl, and descriptions are still not stored);
the second is solved. **Still to decide:** embed resumes and rank by vector, or
return to the scored-badge design below.

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

*Re-checked the evening of 7 Sep: 60,750 open, 32,643 in a family, 81,014 rows
altogether. The shape is unchanged and the design below still holds — the
per-person × per-job arithmetic is what drives it, not the exact totals.*

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

## 5. Crawl cadence — the crawl runs a third as often as it should

**Parked by the owner, 7 Sep.** Measured, not fixed.

`crawl.yml` declares six slots an hour — 144 a day. Over the three days to
7 Sep it fired **24 times, about 6% of declared slots**:

```
12:22  ← 7 Sep
06:03    6.3h gap     ← nothing crawled all morning
01:05    5.0h gap
23:13    1.9h gap
21:42    1.5h gap
...
average gap 2.8h, worst 6.3h
```

**Re-measured over the last 22 runs, evening of 7 Sep** — better, because much
of the day was dispatched by hand during the board work, not left to the
scheduler:

```
average gap 1.8h, worst 5.1h
21 gaps: 1.8 1.4 0.4 1.9 5.1 0.3 0.0 0.9 0.1 4.9 1.9
         1.5 2.1 1.9 2.0 1.3 1.8 3.7 0.1 3.3 1.0
```

The two ~5-hour gaps are the scheduler on its own. The sub-hour gaps are manual
dispatches. That contrast is itself the argument for the fix: **dispatch is
honoured immediately, the schedule is not.**

GitHub's scheduler is the cause, and the workflow comment already documents an
earlier measurement of 1 slot in 66. Declaring more slots has improved it from
1.5% to 6% and cannot do better — the ceiling is GitHub's, not ours.

**Why it matters more than it looks.** The stated principle for this product is
that the one job posted in that hour is the one that counts. Per-vendor lanes
fixed postings being missed to BUGS; nothing addresses postings missed because
no crawl ran. A typical unattended blind spot is ~3 hours and the worst seen
is over 6.

*17 Sep — unchanged, slightly worse.* The last 25 crawls (13–17 Sep, 23
scheduled, 2 dispatched): **average gap 3.6h, worst 6.0h.**

```
2.2 2.1 4.9 5.5 6.0 4.0 2.9 2.4 5.0 5.6 4.8 3.1
2.7 2.4 5.0 5.5 0.0 1.5 2.8 3.4 2.7 2.4 4.8 4.9
```

Evidence: [evidence/2026-09-17-pipeline.json](evidence/2026-09-17-pipeline.json)
→ `crawl.cadence_hours` (and the 7 Sep file for the earlier figures).

### Directions, none tried

- An external scheduler that calls `workflow_dispatch` (cron-job.org, a
  Cloudflare Worker cron, any always-on host). GitHub honours dispatch
  immediately — every reliable run in the history above was dispatched.
- Cloudflare Cron Triggers, which the site already has an account for, firing
  the same dispatch.
- A self-rescheduling run: the last step sleeps and re-dispatches, so the chain
  does not depend on the scheduler at all.

The crawler already refuses to run twice inside 45 minutes, so over-triggering
is safe — extra invocations exit in seconds. The repo is public and Actions
minutes are unmetered, so cost is not the constraint.

---

## 6. Colour and profile detail

**Both parked earlier**, after the specific problems were fixed.

- **Colour**: the accent/danger clash was fixed and four page identities exist
  (feed orange, quiet teal, institutions blue, account violet), each checked for
  contrast in both themes. Anything further is preference, not correctness.
- **User details**: applied and seen counts are shown. Anything beyond that —
  saved searches, per-family activity, application history — was deferred.

---

## 7. Postings stranded on retired boards

**Parked by the owner, 7 Sep.** Recorded here so the decision is visible.

*17 Sep — this is now the most costly open item.* The wrongly retired boards
below were revived and that part cleared itself, but 322 lowercase-spelling
boards have since been retired as duplicates, and their postings were frozen
the same way: **712 stale copies are open, 214 of them of jobs the employer
has already withdrawn.** Measurement and fix direction:
[outstanding.md §1](outstanding.md). The 7 Sep text follows.

112 open postings were last confirmed between 1 and 5 September and nothing will
ever confirm or close them, because their board was retired between one crawl
and the next and a retired board is never crawled again. 92 of them would be
served by the feed today.

**It is largely a symptom, not a cause.** 46 of the boards concerned were
retired wrongly — see [outstanding.md §1](outstanding.md). Reviving those makes
the next crawl close whatever has genuinely gone. What would remain afterwards
is the smaller rule change: **when a board is retired, close its open postings.**

Deliberately not done now: that rule touches the same code path that once wiped
a company's whole history when one board failed, and it should not be changed in
the same stretch of work as the revival fix.

---

## Not parked, just not done yet

Moved to **[outstanding.md](outstanding.md)**, which ranks them, carries the
evidence and keeps its own "fixed since" table. Resolved since this section was
first written:

| Was outstanding | Now |
|---|---|
| ~~The name and resume fix is on `main`, undeployed~~ | **Deployed 7 Sep**, run 34120593054. Verified live: a real name is stored in `user_state`. |
| ~~Two orphaned resumes in the `resumes` bucket~~ | **Deleted.** The bucket is empty and verified private. |
| ~~A crawl shard died on a statement timeout~~ | **The write** was fixed in `a491821`. *17 Sep:* the **close-scan read** then failed the same way three times (15–17 Sep); fixed in `ddcaef0` with an index and a longer retry wait, awaiting a green crawl — [outstanding.md §4](outstanding.md). |
| ~~96 boards at 3+ consecutive failures~~ | *17 Sep:* moot — the crawl no longer retires anything (`c5589c7`). 32 active boards carry any failures. |
| ~~The `resumes` storage bucket~~ | **Answered 7 Sep: it exists and is correctly private.** Uploads were failing for an unrelated reason — see `userStateRow` in `src/state/store.ts`. |
| **`/api/feed` returned 503** | Still open, still uninvestigated. *17 Sep:* 2.3–9.0 s against under 1 s elsewhere — [outstanding.md §3](outstanding.md). |

---

## Settled — closed, not parked

Do not reopen these without new evidence.

- **Workable is a Cloudflare bot challenge**, not a rate limit. `cf-mitigated:
  challenge`, `server: cloudflare`, `<title>Security challenge</title>`, and
  none of the rate-limit headers its own API documents. Slowing to one request
  every four seconds still drew ~700 refusals per shard. See
  [corpus-growth.md §0b](corpus-growth.md). *17 Sep: still ~700 a shard. Its
  side effect — Workable postings unconfirmed for days — is open, in
  [outstanding.md §2](outstanding.md).*
- **Board scheduling by tier** — crawling low-yield boards less often. Proposed
  and rejected on the right grounds: freshness is the product, and a role found
  five hours late is the role someone else already applied to. Per-vendor lanes
  solved the underlying problem without skipping anything.
