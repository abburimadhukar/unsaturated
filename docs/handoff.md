# Handoff prompts

Ready-to-paste prompts for picking this work up in a fresh session, where none
of the earlier conversation is available.

**How to use this file.** Find the phase you want, paste the block verbatim as
your first message. Each block is self-contained: it names the files, the
evidence, the trap, and the test that proves it worked. Phases are ordered by
dependency — where one must come before another, it says so.

Every phase assumes these standing rules, so they are repeated inside each
prompt rather than left to be discovered:

- **Explain in plain English.** No jargon dumps, no walls of prose.
- **Say what you plan to do before doing it**, and wait.
- **Never push and never deploy without being told to, separately.** "Fix it"
  means locally.
- **Invent nothing** — no fabricated scores, notes, salaries or employer detail.
- **Test before changing anything**, and test against the case that broke last
  time, not only the happy path.

### Status, 17 September

| Phase | State |
|---|---|
| 1 — revive 46 wrongly retired companies | **Done.** All back and crawling; 0 boards retired on an HTML page. |
| 2 — close postings on retired boards | **Open, and now the top item** — 712 stale copies, rewritten below. |
| 3 — Institutions page | Open, unchanged. |
| 4 — make the crawl run hourly | Open. Average gap 3.6 h, worst 6.0 h (13–17 Sep). |
| 5 — AI match score | Groundwork exists (74,231 job vectors), nothing user-visible. Read [parked.md §4](parked.md) first. |
| 6 — grow the corpus | Oracle, Eightfold and the Internet Archive done. Read [corpus-growth.md](corpus-growth.md), not the prompt's numbers. |
| 7 — verify | Still valid. |

Prompts written 7 Sep quote that day's figures — "597 tests" is now 1,331, and
section numbers in `outstanding.md` have moved. Trust the documents over the
numbers inside a prompt.

---

## Phase 0 — orientation (start here if you know nothing)

```
I'm continuing work on Unsaturated, a job-discovery site at
c:\Users\abbur\Downloads\takehome\unsaturated. It reads jobs directly from
employers' own hiring systems — Workday, Greenhouse, Ashby and nine others —
and serves the roles nobody else surfaces.

Read these four files first, in this order, and nothing else yet:

  docs/state-of-play.md   — where the project is and what is verified
  docs/outstanding.md     — faults with no decision attached, ranked
  docs/parked.md          — work deliberately set aside
  docs/corpus-growth.md   — where more job boards can come from

The raw measurements behind every number in them are in docs/evidence/*.json,
captured 7 September 2026. Numbers older than that need re-checking before you
rely on them.

Then tell me, in plain English and in under twenty lines: what state the
project is in, what you think the single most valuable next piece of work is,
and why. Do not change any code yet.

Standing rules: explain in plain English; tell me your plan before you build;
never git push and never deploy unless I say so in that message — they are two
separate permissions; never invent a number or a fact the data does not
support.
```

---

## Phase 1 — bring back 46 wrongly-retired companies

**Done by 17 Sep** (`c5589c7`, `697de49`, `f645ce0`). Kept as a record; do not
run it.

```
Unsaturated (c:\Users\abbur\Downloads\takehome\unsaturated). Read
docs/outstanding.md sections 1 and 2, and docs/evidence/2026-09-07-boards.json,
before doing anything.

The problem, in short: the crawler correctly separates a board that REFUSED us
from a board that is GONE — that split exists because 2,185 live boards were
once wrongly retired. But it decides using HTTP status codes, and Workday
refuses by serving an HTML challenge page where JSON belongs. The parser
reports "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", which
matches no refusal rule, so it counts as a death. Five of those retire a board.

46 boards are retired for exactly that, holding about 7,877 jobs. I probed
eight of them on 7 Sep and all eight answered HTTP 200 with jobs on them:
spartannash 1123, ppg 713, virtua 735, yai 501, upenn 238, curtisswright 355,
vcuhealth 394, qtsdatacenters 279.

There is a second bug that must be fixed FIRST or the repair will act on bad
data: src/corpus/board-store.ts stores ONE error message for a whole batch —
errorOf.get(slice[0]) — so a board usually carries a different board's error
text. 44 of the 74 retired boards with an attributable error name someone else.
And src/cli/boards-revive.ts decides revival by matching that text.

So, in order:

1. Fix the attribution. Either group the failure write by message as well as by
   failure count, or — better — store the failure KIND ('gone' / 'refused') in
   its own column and have boards-revive read that instead of parsing prose.
   The crawler already computes the kind and throws it away.
2. Make an HTML body classify as 'refused', not 'gone'. A JSON parse failure on
   a text/html response is a challenge page, never a deleted board.
3. Widen REFUSAL in src/cli/boards-revive.ts to match the HTML shape.

Before you write anything, tell me your plan and which files you will touch.

Then test properly. Specifically: workday:comcast answers HTTP 410 and MUST
stay retired — that is the case this class of fix keeps getting wrong. Run
`npm run boards:revive -- --dry-run` and show me the list before anything
writes. Full suite is `npm test` (597 tests) and `npm run typecheck`.

Do not push and do not deploy. Tell me what is committed and what would still
need to happen.
```

---

## Phase 2 — close postings on retired boards

**Do this first now.** Phase 1 is done, so nothing blocks it.

```
Unsaturated (c:\Users\abbur\Downloads\takehome\unsaturated). Read
docs/outstanding.md sections 1 and 5, and docs/parked.md section 7, before doing
anything.

The problem: 712 open postings are stale copies. The same job is stored under
two spellings of one employer's token — smartrecruiters:grab and
smartrecruiters:Grab. The lowercase registry rows are retired ("duplicate
spelling of ...") or absent, a retired board is never crawled, and only a crawl
closes postings. So those 712 were last confirmed 12-13 Sep and never change.
498 duplicate a live posting (the site shows the job twice); 214 are copies of
jobs the employer has already withdrawn. 513 can be served.

Two parts, in this order, each its own change:

1. A one-off guarded close of the 712: an open posting whose own
   provider+token has no active board, where an active board exists for the
   same provider and the same token ignoring case. Back up the keys to
   backups/ first, show me the counts from a dry run, and wait. The Supabase
   write key only exists in GitHub Actions, so a production write from a local
   session goes through the Supabase SQL tool.
2. The rule that stops it recurring: when a board is RETIRED, close its open
   postings. closableBoards() in src/corpus/db-feed.ts only authorises closing
   on boards that answered THIS run — right for a one-off failure, wrong for a
   retirement. greenhouse:clickhouse (20 postings, moved to Ashby) is the other
   case this closes.

The trap: this is the code path that once let a healthy Greenhouse board close
every job from the same company's failing Ashby board, and that once closed
7,041 postings in one run when one employer's career sites were split across
shards. Scoping is by provider+token for that reason. Do not loosen it. A
retirement is a deliberate decision; a failure is not.

Tell me the plan first. Test with the existing suite (npm test, ~1,330 tests)
plus a case proving a one-off failure still cannot close anything. Do not push,
do not deploy, do not write to production without my go-ahead.
```

---

## Phase 3 — the Institutions page is ~30% right

**Independent of phases 1, 2, 4.** This is the largest *quality* problem in the
product, as opposed to the largest correctness problem.

```
Unsaturated. Read docs/parked.md section 1 in full before anything else — it
carries the measurement and the exact reason this shipped wrong.

Short version: the /institutions page classifies employers into education,
government, health, nonprofit and research. Reading the actual employers
behind 867 classified roles, the majority are not institutions at all. A bank
that recruits from universities is filed as education. A defence contractor is
filed as government. A medical device maker is filed as health.

The cause is precise and worth understanding before touching a rule: the rules
were validated against Cornell (which writes unmistakably like a university,
6 of 6 correct) and against health-tech startups (which a vendor guard
correctly refuses, 17 of 17). An ORDINARY LARGE EMPLOYER was never tested, and
that is where every false positive lives.

The fix direction: the rules currently test whether an advert MENTIONS an
institution. They need to test whether the employer IS one. An institution
describes itself — "our patients", "our students", "the University",
"501(c)(3)". A vendor describes its market — "City of Austin" in a location
line, "patient care" as a product, "we recruit from universities".

Keep three things that already work: the VENDOR guard, requiring a description
before any verdict, and using the employer name only as a tie-breaker.

File: src/taxonomy/sector.ts. Tests: tests/sector-and-admin.test.ts.

Before you ship anything, build a test set of ORDINARY EMPLOYERS — a bank, an
IT consultancy, a pharma company, a defence contractor, a device maker — and
show me how the current rules and your new rules each score on it. That test
set is what was missing.

There is also an open question I have not decided: whether to take the page
down while this is fixed. Give me your recommendation with the reasoning.

Plan first. Do not push, do not deploy.
```

---

## Phase 4 — make the crawl actually run hourly

**Independent.** Small, self-contained, and it improves everything else.

```
Unsaturated. Read docs/parked.md section 5 and
docs/evidence/2026-09-07-pipeline.json.

.github/workflows/crawl.yml declares six slots an hour — 144 a day. GitHub's
scheduler actually fires it about 6% of the time. Measured over the last 22
runs: average gap 1.8 hours, worst 5.1. The short gaps in that data are manual
dispatches; the long ones are the scheduler left alone. Dispatch is honoured
immediately, the schedule is not — that contrast is the whole argument.

This matters because freshness is the product. The stated principle is that the
one job posted in that hour is the one that counts. Per-vendor lanes fixed
postings missed to bugs; nothing addresses postings missed because no crawl
ran.

Three directions, none tried:
  - an external scheduler calling workflow_dispatch (cron-job.org, a Cloudflare
    Worker cron, any always-on host)
  - Cloudflare Cron Triggers — the account already exists for the site
  - a self-rescheduling run whose last step re-dispatches

Over-triggering is safe: the crawler refuses to run twice inside 45 minutes and
extra invocations exit in seconds. The repo is public so Actions minutes are
unmetered. Cost is not the constraint.

Recommend ONE and tell me why, with what it would cost to run and what breaks
if it stops. Then wait for me before building.

While you are in the workflows: docs/outstanding.md section 6 records that a
discovery shard dies on a network connect timeout, failing the whole run even
though the other ten shards succeeded. Same shape as a bug already fixed for
writes in commit a491821. Mention whether it belongs in this change or its own.
```

---

## Phase 5 — the AI match score

**Fully designed, nothing built.** Read the design before proposing anything —
it already rules out the obvious approach for measured reasons.

```
Unsaturated. Read docs/parked.md section 4 completely before you respond. It is
a finished design with the arithmetic behind it, and it forecloses the obvious
approach.

The feature: with a resume on file, score every job against it and show a small
badge on the card. Remove the Newest / Best match / Salary selector.

Two blockers on day one, both real:
  - Job descriptions are NOT STORED and never have been. The crawler reads
    each one, classifies from it, and discards it. There is no description
    column. So today there is literally nothing for an AI to read.
  - Resume text is not stored either, deliberately — only extracted skills and
    a character count.

The constraint everything bends around: matching is per PERSON × JOB. About
32,600 browsable jobs across a handful of seats, growing by ~10,000 jobs a day.
OpenRouter's free tier allows roughly 20 requests a minute and 50 a day, rising
to ~1,000 a day after $10 of credits is bought once. Scoring every job for
every person is off by four orders of magnitude.

The design that follows from that: never call the AI per job. Call it per
screenful, and never for the same job twice. Three parts — a ~500-character
match_digest written DURING THE CRAWL (which backfills itself within two hours
because the crawler re-upserts every job hourly); one AI call when a resume is
saved, producing an ~800-character profile on user_state; and a job_match cache
table so a screenful costs one call, forever.

The limitation that must be said out loud to users: this can rank jobs already
LOADED. It cannot sort all 32,600 by fit. Corpus-wide ranking needs embeddings,
and OpenRouter is chat-only with no embeddings endpoint, so that needs a second
provider.

Decisions still open, listed at the end of that section — including whether
credits are bought (50/day vs 1,000/day changes the plan) and which free model.
Ask me those before you build.

Build order is in the doc and step 1 deliberately ships nothing AI-powered, so
the site is unchanged if we stop there. Follow it.

The OpenRouter key goes in as a Worker secret the way SUPABASE_SECRET_KEY does
in deploy-cloudflare.yml. Never in the repo. Do not ask me to paste it in chat.

Plan first. Do not push, do not deploy.
```

---

## Phase 6 — grow the corpus

**Independent, open-ended.** Do Phase 1 first if you want the numbers to mean
anything, since 46 boards are currently invisible.

```
Unsaturated. Read docs/corpus-growth.md in full — it lists what is left, sized,
and what is already ruled out with reasons. Do not re-derive the ruled-out
ones.

Current state: 25,161 active boards, 60,750 open jobs, 12 hiring systems
connected. Workday is a fifth of the boards and nearly half the jobs.

The two nearest opportunities, from that document:
  - Rippling: an adapter already exists, 938 tenants sit in the Common Crawl
    index, and only 4 boards are registered. Discovery was never wired to it.
  - iCIMS: 687 subdomains in the index, university-heavy, but it needs an
    adapter written from scratch.

Already ruled out, measured, do not revisit: older Common Crawl snapshots
(10% of those boards are still alive), and Workable (a Cloudflare bot challenge,
not a rate limit — the evidence is in corpus-growth.md section 0b).

Tell me which one you would do and what it is worth in jobs, before writing
anything. Then wait.
```

---

## Phase 7 — a session that just needs to verify

For when you want to know whether anything has drifted, without changing
anything.

```
Unsaturated (c:\Users\abbur\Downloads\takehome\unsaturated). I want a health
check, not a change. Touch no source files.

Baseline to compare against is docs/evidence/*.json, captured 7 September 2026,
and the summary in docs/state-of-play.md.

Check and report, in plain English:
  1. npm test and npm run typecheck — both were clean (597 tests, 0 failures).
  2. The live site at https://unsaturated-jobs.rarejobs.workers.dev — pages,
     the feed, input validation, and that the three profile routes still answer
     401 to an anonymous caller.
  3. The corpus totals against the baseline. Job rows only ever grow; a drop is
     a problem. Open jobs were 60,750; boards active 25,161; retired 411.
  4. The last few crawl and discovery runs — `gh run list`. Any shard failing,
     and on which commit.
  5. Whether the count of boards retired on an HTML-parse error has moved from
     46 (docs/outstanding.md section 1).

To query the database read-only you need the Supabase publishable key; ask me
for it. Anything that WRITES needs the service key, which I will only hand over
for a specific task. Tell me if you need it and what for.

Report what changed and what did not. Recommend nothing unless I ask.
```

---

## If you have to split a phase further

The phases above are sized to fit one working session each. If one runs long,
these are the natural seams:

| Phase | Split at |
|---|---|
| 1 | After the error-attribution fix, before touching `boards-revive`. The attribution fix stands on its own and makes the second half safe. |
| 3 | After the ordinary-employer test set exists and both rule sets are scored on it, before rewriting a single rule. The test set is the deliverable. |
| 5 | After step 1 of the build order — the table, the route, the badge, falling back to the existing local score. Nothing AI-powered has shipped at that point, so it is a safe place to stop for good. |

---

## What must never be in a prompt

The Supabase service key, the OpenRouter key, or any other secret. They do not
belong in a file, a chat message, or a commit. A phase that needs write access
should ask for it at the moment it is needed and say what for.

The service key currently in use was pasted into a chat on 7 September and
**should be rotated** — noted in [outstanding.md](outstanding.md).
