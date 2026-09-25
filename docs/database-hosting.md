# Where the database should live next

Research done 24 September 2026, when the Supabase free plan ran out of room.
Every number below was measured on the live database or checked against the
provider's own page that day. Free tiers change often — recheck before acting.

---

## Why this came up

The Supabase free plan allows 500 MB. On 24 September the database reached
**0.511 GB** (Supabase counts all databases on the instance, in decimal GB —
`postgres` plus the two template databases).

A week of work brought it back to **0.449 GB**:

- The purge of closed jobs had never run (window was 45 days on a 24-day-old
  database). Fixed, then fixed again when it timed out.
- Three indexes were rebuilt. Two were 12× and 14× larger than their contents.
- Two unused indexes on `exclusions` were dropped.

That stopped the growth. It does not make room for growth. More boards are
planned, so the database needs a bigger home.

---

## 40% of the database is not used yet

> **Update, 25 Sep 2026: removed.** `job_embedding`, the resume-vector columns
> and resume tailoring were all removed, freeing ~200 MB. The analysis below is
> kept because it is why. The size numbers elsewhere in this file predate it.

**`job_embedding` — ~180 MB, 40% of the database — is written and never read.**

- No query selects the `embedding` column. The only read is
  `job_key, source_hash, model`, to decide whether to re-embed
  (`src/matching/store.ts`).
- No SQL uses a vector operator (`<=>`, `<->`) and there is no vector index.
- The migration that created it (`2026-09-11-match-vectors.sql`) calls it
  *"somewhere to put the map"*. Vector ranking was never wired up; "Best match"
  still falls through to `order by key asc`.
- It was costed at ~57 MB. It is ~180 MB because it embeds every job, including
  closed ones — 52,644 of its rows belong to closed jobs.

So the live data is **~270 MB**, not 450. When vector search is built it will
need an HNSW index, which roughly doubles the embedding storage. Plan for both.

---

## What has to move

Not just a Postgres database. The app uses six Supabase products:

| What | Used by | Hard to replace? |
|---|---|---|
| Postgres 17 + pgvector (`halfvec(384)`) | Everything | No |
| **PostgREST** | **75 call sites** via supabase-js | **Yes** — it is the data layer |
| **Auth** (magic-link email OTP) | Sign-in | **Yes** — also needs an email sender |
| Storage | Résumé uploads | Medium |
| Row level security | User tables | No |
| 4 SQL functions | `feed_page`, `feed_facets`, `record_exclusions`, `seats_taken` | No |

Only two files create a Supabase client: `src/db/supabase.ts` (`db()`,
`dbWrite()`) and `src/state/auth.ts` (`auth()`). User data is touched by three
files: `src/state/store.ts`, `app/api/admin/route.ts` and
`app/api/profile/resume-file/route.ts`. The site never joins user tables to job
tables in SQL — the "applied" filter runs in the browser.

### Growth estimate

| Scenario | Rough size |
|---|---:|
| Today | ~0.45 GB |
| 2× boards + vector search with an index | ~1–1.5 GB |
| 5× boards | ~3–4 GB |

---

## Options checked

| Option | Free storage | Verdict |
|---|---:|---|
| Neon | 0.5 GB | ❌ Same ceiling. Also suspends after 100 compute-hours a month, and the crawler never stops. |
| Prisma Postgres | 0.5 GB | ❌ Same ceiling |
| Supabase (current) | 0.5 GB | ❌ Where we are. Pauses after a week of inactivity. |
| Aiven | 1 GB, 1 GB RAM | ⚠️ Real Postgres, but only doubles the ceiling |
| CockroachDB Basic | 10 GiB | ❌ Not real Postgres. PostgREST and the Supabase stack do not run on it. |
| Xata | ~~15 GB~~ | ❌ **Retired.** Now a 14-day, $100 trial credit. Many 2026 comparison articles still list the old 15 GB. |
| Render | 1 GB | ❌ Free databases are deleted after 30 days |
| Railway | — | ❌ Trial credit only |
| Cloudflare Vectorize (vectors only) | 5M stored dimensions | ❌ 5,000,000 ÷ 384 = **~13,000 vectors**. We need 108,000+. |
| **Oracle Cloud Always Free** | **200 GB, 12 GB RAM** | ✅ **The only option with real headroom** |

Xata and Vectorize were checked specifically because each looked like the answer
at first. Neither is.

---

## Recommendation: split it

```
Supabase free (keep)       →  sign-in, résumé files, user_state, job_events, app_seats   (~2 MB)
Oracle Always Free (new)   →  jobs, boards, exclusions, job_embedding, crawl_runs,
                              facet_snapshot                                             (~450 MB, 200 GB of room)
```

### Why split instead of moving everything

- **Sign-in stays managed.** Self-hosting auth means running an email sender,
  patching auth, and — if the server goes down — nobody can log in. Supabase does
  this for free, and at ~2 MB it will never approach its limit.
- **The code change is small.** Point `db()` / `dbWrite()` at Oracle; give the
  three user-data files a client that still points at Supabase.
- **Oracle runs something simple.** Postgres + PostgREST — two containers, not
  the eleven in the full Supabase stack.

### What Oracle gives

| | Supabase free | Oracle Always Free |
|---|---:|---:|
| Disk | 500 MB | 200 GB |
| RAM | ~224 MB Postgres cache | 12 GB |
| Compute | shared | 2 ARM cores (Ampere A1) |
| Cost | £0 | £0 |

**The RAM fixes the frontend.** The 3-second timeouts and the blank pages this
week came from tables not fitting in a 224 MB cache. With 12 GB the whole
database fits in memory many times over.

**Connect it with Cloudflare Tunnel** — free, and the site already runs on
Cloudflare. It gives the server an HTTPS address without opening ports.

### Alternative: move everything to Oracle

Run the full self-hosted Supabase stack on the Oracle box (needs 4 GB RAM
minimum, 8 GB recommended — 12 GB fits). One system, and the code changes are
only URLs and keys. The cost is operating auth, storage and an email sender
yourself, and a single point of failure for sign-in.

---

## Risks

| Risk | Detail | Mitigation |
|---|---|---|
| Card needed to sign up | Identity check; the free tier does not charge | — |
| Region is permanent | Free resources exist only in the home region picked at signup. US regions often show "out of host capacity" for days. | Pick **Singapore**, Frankfurt or Tokyo — these usually provision within minutes. Singapore is closest. |
| Free tier can shrink | Oracle halved Ampere A1 from 4 OCPU / 24 GB to 2 OCPU / 12 GB around 15 June 2026, with no announcement | 12 GB is still far more than needed. Keep backups off the box. |
| Idle reclamation | Reclaimed if CPU, network **and** memory (A1) are all under 20% at the 95th percentile for 7 days | Postgres memory plus the crawler keeps it above that |
| Supabase pauses | Once crawler writes move off, Supabase sees only sign-ins; free projects pause after a week idle | Weekly ping from a GitHub Actions cron |
| You run the database | Backups, updates, security | Automate backups on day one |
| Latency | Crawler runs in GitHub's US runners; Singapore adds ~170 ms per round trip | Writes are chunked (~50 chunks a shard), so a few seconds per crawl. Queries get far faster from the RAM alone. |

---

## Before migrating

1. **Stop embedding closed jobs.** Only embed jobs the site can show. Cuts the
   embedding table by about a third and makes the move smaller.
2. **Don't rush.** At 0.449 GB with the purge working, growth has stopped.
3. **Decide split vs everything.** The split is recommended.

## Migration outline (split)

1. Sign up for Oracle Cloud, home region Singapore.
2. Create an Ampere A1 VM (2 OCPU / 12 GB), Ubuntu.
3. Install Postgres 17 + pgvector, and PostgREST.
4. Install `cloudflared`; expose PostgREST at `/rest/v1` through a Tunnel.
5. Apply the job-table migrations from `src/db/migrations/`.
6. Copy data with `pg_dump` / `pg_restore` for the job tables only.
7. Add a second client for user data; point `db()` / `dbWrite()` at Oracle.
8. Run the crawl against Oracle; compare counts with Supabase.
9. Switch the site; keep Supabase job tables for a week as rollback.
10. Add the weekly Supabase ping and nightly backups.

Effort: about a weekend, much of it waiting on Oracle setup and the data copy.

---

## Sources

- [Cloudflare Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Oracle Always Free Resources — idle reclamation policy](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Oracle quietly halves free tier Ampere A1 limits — InfoQ, July 2026](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)
- [Oracle Cloud free tier 2026: 4 OCPU/24GB cut to 2 OCPU/12GB — TerminalBytes](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/)
- [Beating "Out of Host Capacity" on Oracle free tier — Medium, July 2026](https://medium.com/@isameer3056/beating-out-of-host-capacity-how-i-automated-my-way-into-an-oracle-cloud-free-tier-vm-9935af02f4ab)
- [Free PostgreSQL hosting comparison 2026 — freebase-cloud](https://github.com/freebase-cloud/free-postgres-hosting)
- [Xata alternatives 2026](https://layerbase.com/blog/xata-alternatives)
- [Changes to the Xata free plan](https://xata.io/blog/changes-free-tier)
- [CockroachDB Basic cluster planning](https://www.cockroachlabs.com/docs/cockroachcloud/plan-your-cluster-basic)
- [Supabase self-hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)
- [Neon plans](https://neon.com/docs/introduction/plans)
