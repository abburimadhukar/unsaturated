# Outstanding — faults and gaps with no decision attached

**Re-checked 17 September 2026** against the live database, the live site and
the last 40 crawl runs. First written 7 September; what was fixed since is in
the table at the bottom, so nobody re-opens it. **§3 updated 1 October 2026**
with the edge-cache shield shipped that day.

These are not parked. Nobody chose to defer them; they are simply not done.
Ranked by what they cost. Work that WAS deliberately deferred is in
[parked.md](parked.md).

Raw output: [evidence/2026-09-17-*.json](evidence/). Figures not in those files
were measured with SQL the same day and are marked *(SQL, 17 Sep)*.

---

## 1. 712 stale copies of postings are live on the site

**The largest correctness problem open now.** It replaced the old "112 stranded
postings" item and is six times its size.

The same job is stored twice, under two spellings of one employer's token —
`smartrecruiters:grab` and `smartrecruiters:Grab`, `ashby:snowflake` and
`ashby:Snowflake`. The lowercase spellings match the old hand-made list
`discovered-boards.json` (all six checked are in it, lowercase); the registry
holds the vendor's own spelling. The lowercase registry rows are now either
retired as "duplicate spelling of …" (322 such rows exist) or absent, and the
postings under them were last confirmed on 12–13 September. When exactly each
row was retired is not recorded. Retiring them was right — but a retired board
is never crawled again, and only a crawl closes postings, so everything stored
under the lowercase spelling is frozen as it was.

*(SQL, 17 Sep)*

```
stale lowercase copies, open          712   last seen 12–13 Sep
  copy of a posting still open        498   ← the site shows the job twice
  copy of a posting since CLOSED      214   ← the site shows a withdrawn job
  in a real family (can be served)    513
across 46 employer tokens: Grab 67, Snowflake 65, Delivery Hero 61,
Experian 56, Canva 36, SGS 32, Endava 31, Mirantis 30 …
```

The remaining 25 of the 737 open postings with no active board are
`greenhouse:clickhouse` (20, see §5) and a handful of single rows.

### Fix direction

Two parts, and the first is safe on its own:

1. **Close the stale copies once.** A guarded update: close an open posting
   when its own spelling has no active board AND the active spelling of the same
   token exists. Back up the keys first. Every one of the 712 is either a twin of
   a live posting or a posting the employer already withdrew, so closing loses
   nothing that is real.
2. **Close a board's postings when it is retired**, so this cannot recur. This is
   the rule parked on 7 Sep ([parked.md §7](parked.md)); it touches the code path
   that once wiped a company's history, so it wants its own change and its own
   tests.

---

## 2. Workable postings go days without being confirmed

**The block itself is settled — do not reopen it.** Workable answers the crawl
with a Cloudflare bot challenge, not a rate limit; see
[corpus-growth.md §0b](corpus-growth.md) and
[parked.md, Settled](parked.md). It is still happening, at the same scale:
refusals per shard on the 17 Sep 10:23 crawl were 694, 695, 722 and 759 —
**2,870 of 3,051 Workable boards** — and every crawl back to 13 Sep shows the
same.

What is NOT settled is the side effect, which 7 Sep did not measure. The ~6% of
boards that get through differ from crawl to crawl, so each Workable board is
confirmed only every few days *(SQL, 17 Sep)*:

```
Workable open postings            2,518
  confirmed in the last 12 hours    222
  not confirmed for 48 hours      1,026   on 246 boards
  oldest confirmation              6 Sep
```

A refused board is never allowed to close anything, which is right — so a
Workable job the employer withdrew stays on the site until that board happens
to get through.

### Decision needed

Whether a posting nobody has confirmed for N days should stop being served —
for every vendor, not just Workable — or whether the site should say how
recently a posting was confirmed. Either is a small change; which one is a
product call. Recruitee (5–20 refusals a shard) and Personio (1–2) show the
same challenge at a much smaller scale.

---

## 3. `/api/feed` — 503s fixed at the edge and then at the origin

**Cache mitigation shipped 1 Oct 2026 (deploy run 36825411996).** The symptom
the owner reported — pages slow to load and an intermittent "job data is
temporarily unavailable" — was reproduced live on 30 Sep: the heaviest view,
`/api/feed?family=cloud&sort=newest`, returned **503 on all three attempts** at
~6.7 s each, and the family feeds took 6–7 s cold. The underlying cause is
unchanged from the database analysis: on the free tier the corpus (now ~683k
rows ever seen, ~104k in scope) does not fit the ~224 MB cache, so a cold count
over it exceeds the 3-second statement limit. See
[database-hosting.md](database-hosting.md).

What changed is the edge, not the database:

- `CACHE_HEADER` on the three read routes (feed, quiet, institutions) kept its
  60 s fresh window but extended `stale-while-revalidate` from 300 s to **24 h**
  and added **`stale-if-error=24h`**. Cloudflare's zone cache honours both on the
  free plan. A view that has fallen out of cache no longer makes a visitor wait
  on a cold query, and a database timeout serves the last good copy instead of a
  503. The degraded (facets-missing) header is deliberately left at 5 s with no
  SWR, so a wrong answer still self-heals fast.
- `scripts/warm-cache.mjs` + a `warm` job in `.github/workflows/crawl.yml` fetch
  the ten common landing views after each hourly crawl, so the first real
  visitor never draws the cold card.

```
/api/feed?family=cloud   before (30 Sep)      after (1 Oct, warmed)
                         503 × 3, ~6.7 s      200, cf=HIT, ~0.3 s
family feeds (cold)      6 – 7 s              67 – 105 ms  (cf=HIT)
quiet / institutions     up to 1.4 s, expiring 25 – 115 ms (cf=HIT)
```

### Origin-side fixes shipped the same day (1 Oct 2026)

The cache was a shield; these address the origin so it does not depend on one.

- **Route A — the family tabs read a per-crawl snapshot** (migration
  `2026-10-01-feed-family-fast.sql`). The bare family tabs (`?family=cloud`) went
  through `feed_page`, which counts the family's whole match for its total — the
  ~3 s query that 503'd. Now a family tab's rows come from `feed_newest(p_family)`
  (no count) and its counts from `facet_snapshot.by_family`, written per crawl by
  `refreshFacetSnapshot`. Live: `family=cloud` 503→~0.3 s `cf=HIT`, ~0.5 s cold.

- **A composite index for family+country** (`jobs_family_country_posted_idx`,
  migration `2026-10-01-feed-filter-index.sql`). A family AND a country together
  (cloud + US) still 503'd: single-column indexes on each meant a scan of ~16,600
  cloud rows re-checking country per row. The composite partial index cut the
  count 6.4 s → 0.7 s and `feed_page(cloud+US)` 6.4 s → 2.6 s. Live, the heavy
  combos now return 200 in ~1–2 s where they were 503.

- **`feed_rows` fallback** (migration `2026-10-01-feed-rows.sql`) — `feed_page`'s
  filter logic verbatim with the count removed. When `feed_page`'s count times out
  but the facets came back, the route serves the rows from `feed_rows` and takes
  the total from `adjacent.core` (exact while adjacent roles are excluded, so
  skipped for `adjacent=include|only`). Rows verified byte-identical to feed_page
  across six filter sets. `feed_page` itself is untouched.

**What remains.** The very heaviest combo (cloud + US) on a cold cache can still
take ~7 s on the first hit — but it now **succeeds** (no 503) and is ~1–2 s after.
Making that first cold hit fast is the database move in
[step2-database-move.md](step2-database-move.md) / [database-hosting.md](database-hosting.md),
still the real cure as the corpus grows.

---

## 4. Crawl freshness — confirming the close-scan fix

**Fixed 17 Sep, not yet proven by a crawl.** Three of the last 40 crawls
(15 Sep 02:05, 15 Sep 20:36, 17 Sep 10:44) failed in the close-scan with
`canceling statement due to statement timeout`: the query read all 84,637 open
postings on every call. An index was added (`jobs_open_board_idx`, 984 kB — the
same query now reads 1,528 buffers instead of 17,988) and the read retry waits
2–30 s instead of 250 ms (`ddcaef0`).

**To close this:** the next few scheduled crawls finish green with no
`close-scan page … failed` lines.

---

## 5. Duplicate postings from two other causes

Unchanged since 7 Sep.

- **ClickHouse moved from Greenhouse to Ashby.** `greenhouse:clickhouse` is
  retired on a 404 but its 20 postings are still open, last seen 1 Sep. Fixed
  by §1 part 2.
- **`recruitee:foodlabs` and `recruitee:jobsatlanticvc` are the same board.**
  Both still active. `boards-dedupe` groups by token, so two different tokens
  for one board are invisible to it; grouping by resolved host would catch it.

The evidence collector counts 342 open postings sharing a title across two of
our boards (`duplicates.repeat_title_across_two_of_our_boards_OURS`); most of
those are §1.

---

## 6. Housekeeping

- **`workday:comcast` still has an ACTIVE row for site `robots`** that answers
  HTTP 410. Its real site `Comcast_Careers` is correctly retired. Retire the
  `robots` row.
- **`discovered-boards.json` is still read by every crawl.** 7 Sep called it a
  historical artefact; it is not — `loadBoardsAsync()` in
  `src/corpus/boards.ts` merges it with the registry, and its lowercase spellings match §1. Do not delete it without changing that
  merge first.
- **`data/feed-snapshot.json`** is still read, by `src/corpus/snapshot.ts`, as
  the fallback feed. Live, not an artefact.
- **The evidence collector's provider list is stale.** `by_provider` in
  `evidence/2026-09-17-corpus.json` lists iCIMS and Jobvite, which have no
  boards, and misses Oracle and Eightfold. Update `collect.mjs`.
- **Keys to rotate.** The Supabase service key was pasted into a chat on 7 Sep,
  and the OpenAI key sits in `.dev.vars`. Neither is in a tracked file. Rotation
  cannot be verified from here.
- **Eightfold's 12 boards hold no postings yet.** Stored 17 Sep 13:01; the next
  crawl reads them. Check they fill.

---

## Fixed since 7 September

Verified 17 Sep, not taken from commit messages.

| Was | Now |
|---|---|
| **46 live Workday companies retired** on an HTML challenge page (~7,877 jobs) | All back. SpartanNash, PPG, Virtua, YAI, UPenn, Curtiss-Wright, VCU Health, QTS, Flowserve and NTST are active and were crawled successfully on 17 Sep. Retired boards carrying that error: **0**. Retirement was taken out of the hourly crawl (`c5589c7`), and `boards:revive` now asks the board instead of reading its message (`697de49`). |
| **A board's error text was usually a neighbour's** (44 of 74) | Fixed in `f645ce0`. 4 retired rows still carry text written before the fix; harmless, since revival no longer reads the text. |
| **A discovery shard died on a network timeout** | The index reads now retry three times with back-off. The last two discovery runs are green. |
| **19 boards one failure from retirement** | Moot: the crawl no longer retires anything. 32 active boards carry any failures today; 3 are at four. |
| **Crawl shards split one employer's career sites** | Fixed 16 Sep (`1a00f28`): multi-site tenants closed 7,041 postings in one run before, 65 after. |
| **122 Oracle career sites were exact duplicates** | Retired 16 Sep as "duplicate site of …", every posting ID compared. |
| **Crawl close-scan timeouts** | Fixed 17 Sep, awaiting proof — §4. |
| **`/api/feed` 2–9 s, occasional 503** | Faster 17 Sep; 1 Oct an edge-cache shield (SWR + stale-if-error) + hourly warm took common views to ~0.3 s `cf=HIT`, THEN origin fixes landed the same day: Route A (family tabs off the live count), a family+country index (count 6.4 s→0.7 s), and a `feed_rows` fallback. Heavy filtered combos now return 200 (~1–2 s) where they were 503. Only the very heaviest cold first-hit is still slow — §3. |
| **"After applying" lost your place** | Fixed 1 Oct. The back link dropped the filters, so returning reset to the top of an unfiltered list. It now carries path AND filters (validated by `src/ui/back-link.ts`), and Quiet/Institutions gained the main feed's scroll+page memory (`src/ui/restore.ts`). |
| **No seen/applied marking on Quiet & Institutions** | Fixed 1 Oct. Opening a posting there now dims the card and marks it applied, the same as the main feed — the shared `JobCard` gained the behaviour via `app/_components/useJobState.ts`. The main feed was already correct and was left unchanged. |

---

## What is NOT a problem, despite looking like one

| Looks wrong | Actually |
|---|---|
| 5,036 open postings share a title on one board | The **employer's** own doing — one title, several requisition IDs. |
| 39,182 open jobs are `unsorted` | Real postings outside the four families. Not shown in the feed. |
| 1,844 open postings not confirmed for 48 hours | 1,026 are Workable (§2) and 712 are §1. Not a crawl failure. |
| 322 retired boards say "duplicate spelling of …" | Correct — a lowercase copy of a live token. Their postings are §1. |
| 12 Eightfold boards with no jobs | Stored hours ago; not crawled yet. |
| `includeUnknown` returns jobs with no country | Deliberate. |
| `/api/admin` returns 404 | Deliberate. |
