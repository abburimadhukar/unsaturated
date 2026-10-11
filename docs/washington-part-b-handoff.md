# Handoff prompt — Part B: Washington employer coverage

_Paste the block below to a fresh Claude Code session (or hand it to an engineer) to start Part B. It assumes Part A is live. Full context is in [`washington-part-a-and-part-b-plan.md`](./washington-part-a-and-part-b-plan.md); read that first._

---

You are continuing work on **Unsaturated**, a direct-ATS tech-jobs app (Next.js on Cloudflare Workers via OpenNext, Supabase Postgres). The corpus is built by crawling employers' **own** ATS boards hourly — never aggregators.

**Part A is done and live:** a `/washington` page backed by a `region` column on `jobs`, populated at crawl time by `inferUsState()` in `src/ats/geo.ts`. `region='WA'` is now the measurement instrument for everything below.

## Your task — Part B
Grow the corpus so `/washington` approaches full coverage of Washington State employers — companies, universities, hospitals, schools, NGOs, government — for tech-touching roles. "Every" is an asymptote; your target is **measured WA coverage climbing over time**, reported honestly against a denominator, not a claim of completeness.

## Start here (do this before writing any code)
1. Read `docs/washington-part-a-and-part-b-plan.md`, `docs/state-of-play.md`, `docs/corpus-growth.md`, and the memory notes on corpus growth and the ship gate.
2. **Measure the baseline.** Run read-only SQL (Supabase MCP, project `vupjabahniolbnbmeidk`): current `count(*) where region='WA' and closed_at is null and family is not null`, distinct WA employers, and the split by `boards.source`. Record it — this is your before-number.
3. **Verify the machinery's real signatures before reusing them** (memory may be stale): `src/discovery/careers.ts`, `src/discovery/datasets.ts`, `src/discovery/store-verified.ts` (`verifyAndStore`, `freshBoards`), and the CLIs `npm run detect`, `npm run dataset:diff`, `npm run harvest:hn` (all support `--store db`). See how `.github/workflows/discover.yml` wires them.

## Reuse, don't rebuild
- **Careers detection** (`src/discovery/careers.ts` + `npm run detect -- --store db`) already resolves an employer domain → its ATS board. Feed it a **Washington employer→domain list** (today it runs a built-in university/health list). Store results via `verifyAndStore` with a new `boards.source = 'wa'` tag so WA yield is attributable.
- **Dataset diff** (`npm run dataset:diff`) already cross-references `kalil0321/ats-scrapers`. It's geo-agnostic; use it to catch WA employers careers-detection missed.
- `blocked_boards` must stay current — WA employer lists will drag in aggregators, which must never enter.

## Build, in order
1. **Companies (first — highest tech density).**
   - Assemble a WA employer→domain list from: WTIA members; USCIS H-1B Employer Data Hub + DOL OFLC LCA filtered to `state=WA` (also feeds the visa layer — on-moat); WA Secretary of State registry.
   - Run careers detection over it → `verifyAndStore(source:'wa')`.
   - **Write an `amazon.jobs` adapter** — Amazon is the largest WA employer and absent from the corpus; its `search.json` API is public and keyless. **Probe and confirm the endpoint + a real yield number before writing the adapter** (the Oracle/Eightfold pattern). This is the single biggest WA gain. No `src/ats/adapters/amazon.ts` exists yet.
   - **Confirm Microsoft via the existing `src/ats/adapters/eightfold.ts`** (watch the "403 not authorized" tenant gating).
   - Register the known WA Workday giants (T-Mobile, Nordstrom, Expedia, Costco, Starbucks, Providence, UW `uw.wd5`) if not already present; `region` surfaces them automatically.
2. **Universities & nonprofits:** `.edu` list (WSU + community/technical colleges) and ProPublica 990 (WA nonprofits) through careers detection.
3. **Public sector (only if the owner wants it — bigger lift):** a **NeoGov / governmentjobs.com** adapter covers WA state (`careers.wa.gov`), 39 counties, ~281 cities and community colleges in one. K-12 via Frontline/AppliTrack. New adapters — probe first.

## One decision to raise with the owner, don't decide alone
The ingest classifier keeps only in-family tech roles (~17%; recent discovery batches ~5% net-new). So "even a small part tech" at a non-tech WA employer is captured only if the classifier already tags it. Truly widening that net means **loosening the ingest keep-filter for WA employers** — a classifier change with real risk (false positives, corpus bloat, more free-tier DB pressure). Surface the trade-off and the yield estimate; let the owner choose.

## Hard constraints (do not violate)
- **Ship gate:** build locally and stop. `git push`, applying a migration, and deploying each need an **explicit** go-ahead in the owner's message. "Build it" means local only.
- **Harness locks:** you cannot write the database directly or self-merge a PR. Open a PR; the owner merges and runs seeds/backfills with the Actions write key. `gh workflow run` is allowed.
- **Settled calls:** Workable stays off (Cloudflare bot-wall). Honest crawler UA. Probe/measure before building any adapter. Keep `blocked_boards` current.
- **Don't break anything:** mirror existing patterns, read the current code before changing it, and keep the full test suite green (`npm test`, `npm run typecheck`, `npm run build`). Add tests for new adapters and discovery paths.
- **Free-tier DB:** every new board adds hourly-crawl work and statement-timeout pressure. Seed in bounded batches (the discovery CLIs cap per-provider/run); note that the database move ("Step 2") is the real headroom before any large seed.

## Definition of done
- `region='WA'` open-job count and distinct WA-employer count both up materially, attributable via `boards.source='wa'`; before/after numbers reported.
- Amazon crawling via a new `amazon.jobs` adapter; Microsoft confirmed via Eightfold.
- Coverage reported against a WA-employer denominator with the remaining gap named honestly.
- No aggregator admitted, no existing path changed, full suite green. New work on a branch + PR, with the exact migrate/seed/deploy steps written out for the owner.
