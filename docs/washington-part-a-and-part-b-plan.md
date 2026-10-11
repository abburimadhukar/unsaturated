# Washington on Unsaturated — Part A (shipped) & Part B (plan)

_Last updated: 6 Oct 2026. Audience: the engineer or agent who continues this work._

Two pieces were scoped for Washington:

- **Part A — a Washington page.** A state-scoped list page, like Quiet Roles and Institutions. **Built, merged (PR #5), migrated, and deployed.** Live at <https://unsaturated-jobs.rarejobs.workers.dev/washington>.
- **Part B — put every Washington employer's hiring portal into the corpus.** Analysis + plan only, below. **Not started.**

---

## Part A — what shipped

### What it is
A fourth list page, `/washington`, built exactly like Quiet Roles and Institutions: a client page reading a dedicated API route that queries the `jobs` table directly, so `feed_page` and every existing path are untouched.

- Page: [`app/washington/page.tsx`](../app/washington/page.tsx)
- Route: [`app/api/washington/route.ts`](../app/api/washington/route.ts) — filters `region = 'WA'`, returns the list plus an exact per-family count.
- Accent: green (`--page-wa`, Evergreen State), distinct from Quiet's teal and Institutions' periwinkle. Nav link added to the feed, Quiet and Institutions.

### The one data change: a `region` column
The jobs table stored `location` (raw text) and `country` (ISO code) but no state. Matching the location text per request (`location ILIKE '%WA%'`) would be both **slow** (the measured failure `quiet` exists to avoid) and **wrong** (it catches Washington D.C., Warsaw, Walla Walla County in other states). So state is decided once, at crawl time, and stored.

- **`inferUsState()`** in [`src/ats/geo.ts`](../src/ats/geo.ts) — built on top of `inferCountry`, so it inherits every country trap: "Washington, United Kingdom" → GB (never reaches the state logic); "Vancouver, WA" → WA while a bare "Vancouver" → BC → nothing; "Washington, D.C." → DC, "Washington, PA" → PA, "Washington County, OR" → OR (the town/county, not the state). Resolves by: D.C. forms first, then an explicit state code, then the full state name, then an unambiguous city (Seattle → WA). Returns `undefined` for any location positively placed in another country or with no recoverable US state.
- **`jobs.region`** — a plain `text` column (like `sector`), **not** generated (like `quiet`), because the inference has branches a SQL expression cannot carry. Migration: [`src/db/migrations/2026-10-06-region.sql`](../src/db/migrations/2026-10-06-region.sql). Indexed on `(region, family, posted_at) where closed_at is null and region is not null`.
- Written through the crawl like every other field: added to `toJobRow`, `toFeedJob`, `JobRow` and — critically — the **missing-column strip list** in `writeFeed` ([`src/corpus/db-feed.ts`](../src/corpus/db-feed.ts)), so the hourly crawl keeps running before the migration lands. The route reports a missing column as "not switched on yet", the same recoverable state Quiet/Institutions already handle.
- Backfill: `npm run backfill:region` ([`src/cli/backfill-region.ts`](../src/cli/backfill-region.ts)) fills the column from locations already stored, so the page has content without waiting for the corpus to turn over. Optional — the hourly crawl fills it anyway.

### Filters (only what the data supports)
Family (nav, with counts) · search (title/employer) · seniority · **workplace** (the four real `remote_type` values: on-site / hybrid / remote) · **"states a salary"** — 42% of WA roles carry pay, against the 16% that made the toggle dishonest on Quiet Roles. **Adjacent roles are included** here (unlike the sibling pages) and labelled, because this is a geography, not a kind of work — someone in Seattle wants the Solutions Engineer and the TPM alongside the core roles.

### How to operate it
1. Apply the migration (needs `DATABASE_URL`, not the PostgREST key): paste `2026-10-06-region.sql` into the Supabase SQL editor, or `npm run migrate -- 2026-10-06-region`.
2. Populate `region`: either `npm run backfill:region` (needs the write key — instant) or just let the hourly crawl fill it (gradual, ~one crawl cycle).
3. Deploy: the `deploy-cloudflare` workflow (manual dispatch). The crawl never deploys.

Order is forgiving: the missing-column fallbacks mean a deploy-before-migrate or crawl-before-migrate cannot take the live site down — only `/washington` shows "not switched on yet" until the migration is applied.

### Status & numbers
Live and populated. ~575 WA tech roles and climbing as the crawl finishes (pre-build estimate was ~530 core + ~140 adjacent across ~260 employers). 1,164 tests pass (new `tests/geo.test.ts` locks the state traps; `page-shell` now holds the WA page to the shared-shell standard; `job-row` covers `region` in the write-path invariant). `typecheck` and `next build` clean.

### Honest caveats / deferred
- **Metro/sub-region filter (Seattle / Eastside / Tacoma / Spokane) was deferred.** It's the highest-value follow-up on the page itself: Seattle and Spokane are five hours apart. It needs either a light `location` ILIKE over the small WA subset or a stored `wa_area`.
- **The corpus only stores in-family tech roles** (the classifier keeps ~17%). So "even a small part tech" at a non-tech employer appears only if the classifier already tags it — see Part B's keep-filter note.
- **WA detection is approximate.** Bare "Washington" with no qualifier is read as the state after D.C. forms are ruled out; a DC job listed as just "Washington" would be mis-tagged. Rare, and documented in `inferUsState`.
- **Free-tier DB statement timeouts** appear under full-crawl load (measured: ~100 in a 30-min forced-crawl window; a 79 spike also occurred hours before this work existed). The crawl survives them by halving/backing off — that is the slowness, not a failure. The real cure is the database move ("Step 2" in the docs), unrelated to this work.

---

## Part B — put every Washington employer's hiring portal into the corpus

### Goal
Grow the corpus so `/washington` approaches "every tech-touching role at every Washington employer — companies, universities, hospitals, schools, NGOs, government." "Every" is an asymptote; the honest target is **measured coverage against a denominator of WA employers**, climbing over time.

### Why Part A makes Part B measurable
The `region` column is the instrument. Part B's success metric is simply: **count of `region='WA'` open jobs, and distinct WA employers, climbing** — and that count divided by a WA-employer denominator (e.g. WTIA membership, state ICT-firm counts). Without Part A there was no way to measure WA coverage at all.

### The shape of the problem
The corpus is built by reading employers' **own ATS boards** directly (no aggregators). So "add a WA employer" means: find that employer's ATS board (provider + token) and register it in the `boards` table; the hourly crawl then reads its jobs, and `inferUsState` tags the WA ones. Three moves cover most of it, and all three **reuse machinery that already exists**:

1. **Resolve WA employers to boards via careers-page detection.** [`src/discovery/careers.ts`](../src/discovery/careers.ts) + `npm run detect -- --store db` already fetch an employer's careers page and recognise which ATS it runs. Today it runs over a built-in university/health-system list (see `discover.yml`). Part B feeds it a **Washington employer→domain list** instead.
2. **Cross-reference the open ATS dataset.** [`src/discovery/datasets.ts`](../src/discovery/datasets.ts) + `npm run dataset:diff` already diff `kalil0321/ats-scrapers` (company → ATS → slug, with a `domain` column) against the registry. The dataset isn't geo-tagged, so it adds boards everywhere (WA incidentally); its value here is picking up WA employers whose careers page detection missed.
3. **Build adapters for the WA-dominant portals that no generic discovery can reach** (below). These are the employers conspicuously *absent* from the ~260 WA employers already in the corpus.

Stored boards carry a `source` tag (`boards.source`, free text — today 'opendata' / 'commoncrawl' / 'careers' / 'hn' / 'slug' / 'manual'); add a `'wa'` tag so WA yield is attributable. `verifyAndStore` in [`src/discovery/store-verified.ts`](../src/discovery/store-verified.ts) is the verify→upsert path to use. Keep [`blocked_boards`](../src/db/schema.sql) current — open-employer lists drag in aggregators, which must never enter (their apply links point at a middleman).

### The Washington employer universe (where the list comes from)
- **WTIA** (Washington Technology Industry Association) member directory — the densest WA-tech list.
- **WA Secretary of State** business registry (CCFS) — broad, but needs name→domain resolution.
- **USCIS H-1B Employer Data Hub + DOL OFLC LCA** filtered to `state = WA` — every WA employer that sponsors, with city and (via FEIN/name) a resolvable domain. This is **on-moat**: the same data feeds the visa-viability layer the real users need (they're F-1/OPT/STEM-OPT, so sponsorship is the binding constraint). One ingest, two products.
- **WA universities & colleges** — `.edu` list; UW is already on Workday (`uw.wd5.myworkdayjobs.com`), WSU and the community/technical colleges are mostly NeoGov.
- **WA nonprofits** — ProPublica Nonprofit Explorer (IRS 990) filtered to WA → domains → careers detection.

### The big custom portals (the real gaps)
- **Amazon — `amazon.jobs`.** The single largest WA employer and **absent from the corpus**: it runs its own `search.json` API (public, keyless), which no generic ATS discovery reaches. **Needs a new adapter.** Biggest single WA gain. No adapter exists today (confirmed: `src/ats/adapters/` has no `amazon.ts`).
- **Microsoft — Eightfold.** Reachable: the **Eightfold adapter already exists** ([`src/ats/adapters/eightfold.ts`](../src/ats/adapters/eightfold.ts)). This is mostly confirming the tenant works (watch the "403 not authorized" gating noted in the adapter docs).
- **Workday giants already crawlable** — T-Mobile, Nordstrom, Expedia, Costco, Starbucks, Providence, UW. They just need to be registered; `region` then surfaces them on the page automatically.
- **Public sector (optional, bigger lift)** — **NeoGov / governmentjobs.com** covers WA state (`careers.wa.gov`), all 39 counties, ~281 cities and the community colleges in one adapter. K-12 is Frontline/AppliTrack. Both are new adapters; treat as a later phase. (`src/ats/adapters/socrata.ts` and `usajobs.ts` already exist and may help for open-data/federal slices.)

### Sequencing
1. **Companies first** (fastest, highest tech density): WA employer list → careers detection → `verifyAndStore(source:'wa')`, plus the `amazon.jobs` adapter and Microsoft/Eightfold confirmation. Watch `region='WA'` climb.
2. **Universities & nonprofits**: `.edu` and 990 lists through careers detection; register the known Workday tenants.
3. **Public sector** (if wanted): the NeoGov adapter, then K-12.

### The "even a small part tech" decision (flag before building)
The ingest classifier keeps only in-family tech roles (~17%; recent net-new discovery batches kept ~5%). So a "Data Analyst at Seattle Children's" is kept, but an oddly-titled IT role at a non-tech WA employer is dropped. Truly capturing "even a small slice of tech" at non-tech orgs means **loosening the ingest keep-filter for WA employers** — a deeper classifier change with real risk (false positives, corpus bloat, more DB pressure on an already-strained free tier). This is a product decision, not a mechanical one: decide it explicitly before touching the classifier.

### Risks & settled calls to respect
- **Workable stays off** (Cloudflare bot-wall from Actions IPs). Don't re-litigate.
- **Aggregators must never enter** — keep `blocked_boards` current as new lists are imported.
- **Honest crawler UA**; **probe/measure before building** any adapter (the Oracle/Eightfold pattern): confirm the endpoint and a real yield number before writing code.
- **Free-tier DB pressure** — every new board is more hourly crawl work and more statement-timeout pressure. The DB move ("Step 2") is the real headroom; factor it in before a large seed.

### Acceptance criteria
- `region='WA'` open-job count and distinct WA employer count both rise materially, attributable by `boards.source='wa'`.
- Amazon (`amazon.jobs`) present and crawling; Microsoft confirmed via Eightfold.
- Coverage reported honestly against a WA-employer denominator, with the gap named rather than hidden.
- No aggregator admitted; no existing path changed; full test suite green.

### Operating constraints (same as all Unsaturated work)
Build locally and stop. Pushing, applying a migration, and deploying each need an explicit go-ahead. An agent cannot write the DB directly or self-merge — the owner merges PRs and the Actions write key runs the seeds/backfills. See the ship-gate and deploy-mechanics notes.

---

## Build status — 11 October 2026 (first tranche; built locally, tested, NOT shipped)

All of the following is on disk and green: full suite **1,209 tests / 0 fail**, `typecheck` and `next build` clean, Amazon live-probe PASS. Nothing has been pushed, migrated, seeded or deployed — those are the owner's steps below.

### Built
- **Amazon adapter** — `src/ats/adapters/amazon.ts`, the single biggest WA gain, which no generic discovery could reach (Amazon runs its own listings API, not a third-party ATS). Keyless/public `www.amazon.jobs/en/search.json`, SELF_SUFFICIENT (description inline). One registry row per US state (`token=us-wa`), because Amazon is one global board and the per-board cap would otherwise throttle it to 300. The API's `normalized_state_name` filter is LOOSE (returns roles that merely list a WA location), so the adapter keeps only `state===` the board's code. **Live probe 11 Oct: 4,043 primary-WA roles, every field 100% populated.** Wired into `types`, `adapters/index`, `describe` (SELF_SUFFICIENT), `probe`, `saturation` (discovery 0.2 = most-contested, application 0.45). Seed: `npm run seed:amazon` (default WA; `--states`, `--max`). Tests: `tests/amazon.test.ts`.
- **DC-contamination bug — found and fixed.** `inferUsState` was mis-tagging the country-state-city form Amazon and iCIMS use (`US-DC-Washington`, `USA DC Washington`, `US-D.C.-Washington`, `DC-Washington`) as WA — **measured ~14% of the live WA page (182 of 1,303) was actually Washington, D.C.** Fixed in `src/ats/geo.ts` step 1 with an adjacency guard so a warehouse "DC" code near a real WA city is not mistaken for the capital. Must land before Amazon goes live (Amazon writes the same format). Tests added to `tests/geo.test.ts`.
- **Per-board depth override** — `extra.maxJobs` honoured in `mergeBoards` (the registry has no such column), so Amazon reads past the 300 default; additive, every other board unchanged. The WA seed sets 2,000.
- **`detect --source <tag>`** — careers detection can now attribute its yield; default unchanged (`careers`). A starter WA employer list is at `data/wa-employers.txt`.

### Measured, ready for the owner to run
- **WA employer list yield (dry run, 11 Oct):** 17 of 52 domains expose a readable ATS → **23 new boards**, including Costco (iCIMS), Nordstrom (Workday), Providence & Swedish (Oracle), Zillow & F5 (Workday), Alaska Air (iCIMS), DocuSign (iCIMS). Run live with `npm run detect -- --file data/wa-employers.txt --store db --source wa`.

### Microsoft — both paths are currently BLOCKED (measured, not assumed)
The plan above said "Microsoft confirmed via Eightfold." That is wrong, and here is the evidence:
- **Eightfold tenant `microsoft.eightfold.ai` → HTTP 403 `{"message":"Not authorized for PCSX"}`** — a gated tenant, which the Eightfold adapter deliberately refuses to store (a 403 is a door held shut, not a live board).
- **Microsoft's own careers API (`gcsservices.careers.microsoft.com/search/api/v1/search`) is behind Azure CDN and serves a `*.azureedge.net` certificate** from the edge this project reaches — so a correct TLS client (curl AND Node both) rejects it with `ERR_TLS_CERT_ALTNAME_INVALID`. Reaching it would mean disabling TLS hostname verification, a security compromise this project should not take (the same spirit as the honest-UA rule that keeps us off Workable).

Per the project's own rule — **probe and confirm a real yield before writing an adapter** — Microsoft is NOT built: the endpoint cannot be probed from here, and writing an adapter against a schema that cannot be verified is exactly the blind work that rule exists to prevent. The one cheap experiment that settles it is **built and ready**: `gh workflow run ms-probe.yml` runs `scripts/ms-probe.mjs` from an Actions runner (Azure egress may be served the correct cert), with TLS verification ON — never bypassed — and reads a public endpoint, writing nothing. Its log prints **REACHABLE** (with the response shape) or **BLOCKED** (`ERR_TLS_CERT_ALTNAME_INVALID`, same wrong cert → Microsoft stays parked, like Workable). If REACHABLE, a standard secure adapter — scoped per US state like Amazon, built from the printed shape (`operationResult.result.jobs[]`, detail at `/job/{id}`) — is a short, low-risk follow-up.

### Owner go-live checklist (nothing deploys until you say)
1. Merge the branch/PR for this tranche.
2. **Backfill region** to clear the ~14% D.C. rows now mis-shown as WA: `npm run backfill:region` (write key).
3. **Seed Amazon:** `npm run seed:amazon` (write key) — registers the WA board; the next crawl fills it.
4. **(Optional, same tranche) add the WA employers:** `npm run detect -- --file data/wa-employers.txt --store db --source wa`.
5. **Deploy** (`deploy-cloudflare.yml`) so the DC fix and the Amazon adapter are live.
6. **(Separate experiment) Microsoft:** `gh workflow run ms-probe.yml`, then read the run log. REACHABLE → ask for the adapter; BLOCKED → parked, like Workable.

Still pending beyond this tranche: the ingest keep-filter decision for non-tech WA orgs (a product call, unchanged); NeoGov/public sector (a later, bigger adapter); more Amazon states (a one-word `--states` change).
