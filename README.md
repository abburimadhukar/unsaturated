# Unsaturated

A job-application platform that competes on **targeting**, not volume.

## The thesis

Saturation is `applicants ÷ openings`. The numerator is never observable — no ATS
publishes it — so the product is really a *proxy model for applicant volume*,
plus an apply engine that can act on what the model finds.

The arbitrage: every competing tool automates the **low-friction** channel
(LinkedIn Easy Apply, one-click), which is precisely why that channel is
saturated. A bot's real advantage is that it never gets bored — so it should be
pointed at the applications humans abandon halfway through.

Conveniently, ingest difficulty and low competition point the same direction.
Workday is unpleasant to automate, so few bots bother, so its listings stay
under-contested. **The hard-to-reach tier and the low-competition tier are the
same tier.**

## Optimization target

Interviews per application — not applications sent. A tool that fires 500
applications into the most contested listings on the internet is worse than one
that fires 20 into openings with eight applicants.

## Architecture

**Tenancy:** `companies` / `boards` / `jobs` are **global**. Saturation is a
property of a job, not of an applicant, so one crawl and one scoring pass serve
every user; crawl cost stays flat as users are added. Only `candidate_profiles`
and `applications` are per-tenant.

**PII:** confined to `candidate_profiles`, so deletion is one cascading row
rather than a hunt across the schema.

**Review queue:** `applications` moves `drafted → pending_review → approved →
submitted`. There is deliberately no code path that submits without approval.

## Status

### Phase 1 — ingest foundation (built)

Seven ATS adapters, each verified live against a public unauthenticated
endpoint:

| Provider | Endpoint | Notes |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | Full HTML description inline |
| Lever | `api.lever.co/v0/postings/{token}?mode=json` | Whole board in one array; structured salary |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{token}` | Cleanest location data; explicit `isRemote` |
| Workable | `apply.workable.com/api/v1/widget/accounts/{token}` | Listing-only; description needs per-job call |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{token}/postings` | Paginated; enterprise boards run to thousands |
| Breezy | `{token}.breezy.hr/json` | Small-company heavy; no description in feed |
| Personio | `{token}.jobs.personio.de/xml` | Only source with first-class `seniority` + `yearsOfExperience` |

Last probe: **7/7 healthy, 2,636 live jobs, `postedAt` and `applyUrl` at 100%
coverage across all seven.**

`postedAt` is the field that justifies direct ingest: aggregators overwrite it
with their own crawl date, which destroys both the freshness signal and repost
detection.

### Phase 2 — saturation scoring (built)

`src/scoring/saturation.ts`. Five weighted axes plus a ghost-risk suppressor,
producing 0..100 where **higher means less contested**. Ghost risk suppresses
rather than zeroes, so suspicious postings sink but stay inspectable.

Every weight is a documented prior, not a measurement. Phase 5 replaces them
with coefficients learned from real outcomes.

### Web app (built)

`npm run dev` → <http://localhost:3000>. No database and no framework: it runs
the same adapters and the same scorer against live boards, in memory.

Observed spread on 965 live jobs:

| Score | Example | Why |
|---|---|---|
| **70** | SAP consultant, Bordeaux (hybrid) | Niche stack, secondary city, commute-capped |
| **67** | KYC case manager, Benelux (hybrid) | Regulated niche, local pool only |
| **20** | Prescribing Nurse Practitioner (fully remote) | Remote + no qualification moat |

The UI shows the per-axis breakdown and a plain-English reason for every job, so
a ranking can be argued with rather than taken on faith.

### Known gaps

- **The crawler has never run against live Postgres** — no local instance was
  available. Upsert, close-detection and repost-event logic are unexercised.
- **The in-memory feed does not deduplicate.** Lyra Health lists one nurse
  practitioner role across many states and it appears five times. `identity_hash`
  solves this on the Postgres path; the in-memory path has no equivalent yet.
- Seed boards are the seven verified tokens, so the corpus skews to those
  employers. Real coverage needs the resolver run over a large URL corpus.

### Phases 3–5 (not started)

3. Eligibility gate — a filter, not a ranker. Fit and saturation are separate
   axes; blending them corrupts both.
4. Apply engine — Tier 1 form-post, Tier 2 browser for Workday and legacy.
5. Feedback loop — learn which signals actually predict responses.

## Commands

```bash
npm install
npm run probe                 # live adapter smoke test, no DB required
npm run probe -- lever ashby  # probe specific providers
npm run typecheck

npm run db:init               # apply schema.sql (needs DATABASE_URL)
cat apply-urls.txt | npm run resolve            # coverage report
cat apply-urls.txt | npm run resolve -- --save  # register boards
npm run crawl -- --limit 50
```

## Coverage bootstrapping

You don't enumerate ATS platforms, you enumerate **companies**. Every apply URL
in the wild leaks both its ATS and that company's tenant token
(`jobs.lever.co/lyrahealth`, `?gh_jid=`, `apply.workable.com/nationsecurity`).
`src/ats/resolve.ts` harvests those into the `boards` registry; after that the
ATS is polled directly and the original listing source is never needed for
content again.

Unsupported platforms are **classified rather than discarded** — knowing what
share of harvested URLs point at Workday is exactly the input that decides what
gets built next.

On a 13-URL sample of real apply links, Workday was **53.8%** — the largest
bucket by 7×, and the clear next adapter.

## Constraints

- **No LinkedIn or Indeed automation.** Aggressively defended, actively
  litigated, and it is the saturated pool anyway.
- **Never auto-answer** work authorization, visa status, or EEO questions. Those
  escalate to the user via `applications.open_questions`. A guessed answer is a
  misrepresentation on a real application, which is a legal problem rather than a
  ToS one.
- Reading public postings is the low-risk half; **submitting** is where the real
  exposure lives. Honest user-agent, real timeouts, low concurrency.
