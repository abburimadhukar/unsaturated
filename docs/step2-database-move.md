# Step 2 — giving the database a bigger home (runbook)

Written 1 October 2026. Prices and free-tier terms were checked against each
provider's own page that day; **recheck before acting** — free tiers move.

This is the "for later" half of the two-part fix. Step 1 (edge cache) and the
Route A snapshot work stopped visitors seeing the slowness and the 503s. Neither
changes the database, so two things are still true and this runbook is what
answers them:

- the origin database still times out on a cold heavy query — the shields hide
  it, they do not remove it;
- the Supabase free plan is **near its 500 MB ceiling** and the corpus grows.

---

## When to actually do this

Do **not** do it on a quiet day for neatness. Trigger on any of:

1. The Supabase database passes ~**480 MB** again (check: Supabase dashboard →
   Database → Usage), or a write starts failing for space.
2. The `facet_snapshot` warm job or a crawl starts reporting the per-family
   counts "did not come back" for days running — the origin can no longer compute
   even on the 8-second write budget.
3. You decide the ~0.3 s cached experience is not good enough and you want the
   origin itself fast (e.g. before adding the AI match score, which needs
   headroom and pgvector).

Until one of those, the shields are holding and this can wait.

---

## The one decision

Everything turns on **how your code talks to the database**. The site uses
Supabase's PostgREST at ~75 call sites, plus Supabase Auth (magic link) and
Storage (résumés). So:

| Path | Keeps the code? | Cost | Effort | Fixes speed | Fixes storage |
|---|---|---|---|---|---|
| **A. Stay on Supabase, pay for compute** | ✅ everything | ~$25–40/mo | ~1 hour | ✅ (1–2 GB RAM) | ✅ (8 GB) |
| **B. Oracle Always Free (split)** | ✅ keeps PostgREST | £0 | ~a weekend + a capacity lottery | ✅ (12 GB RAM) | ✅ (200 GB) |
| **C. Aiven / Neon free** | ❌ rewrite 75 call sites | £0 | days of rewrite | partly | tight (0.5–1 GB) |

Recommendation: **A if any budget exists, B if it must stay free.** C is a trap
here — the free storage barely moves and you'd rewrite the data layer to get it.

---

## Path A — stay on Supabase, pay for compute (the easy one)

No data move, no code change. You are buying memory.

Current pricing checked 1 Oct 2026 ([Supabase pricing](https://supabase.com/pricing)):
Pro is **$25/mo** per project and includes $10 of compute credit. Compute add-ons:
Micro **1 GB RAM** (~$12, so ~net base), Small **2 GB RAM** (~$24), Medium
**4 GB** (~$48). Pro includes **8 GB** database. The free tier's pain is its
shared ~224 MB; even Micro's 1 GB is ~4.5× that and should hold the ~270 MB
working set; Small (2 GB) is comfortable headroom.

Steps:

1. Back up first: Supabase dashboard → Database → Backups, take a manual one.
2. Upgrade the project to **Pro**.
3. Set the compute add-on to **Small (2 GB)** to start (drop to Micro later if the
   cache hit-rate makes it moot; raise to Medium only if the logs still show
   timeouts).
4. Watch the Postgres logs for a day across crawl hours: confirm `feed_facets` /
   `feed_page` statement timeouts fall to ~zero.
5. Once confirmed, you may lengthen the feed's 60 s fresh window or leave it — the
   origin being fast makes the shields a pure safety net rather than load-bearing.

Rollback: downgrade the plan. No data or code to revert.

Net: ~$25–40/mo, about an hour of work, everything keeps working.

---

## Path B — Oracle Cloud Always Free, split architecture (the free one)

Keep sign-in, résumé files and `user_state` on Supabase (tiny, managed, never
near its limit); move the job tables to Postgres + PostgREST on an Oracle Always
Free ARM box, reached over a Cloudflare Tunnel. This keeps all 75 PostgREST call
sites working — only URLs and keys change.

Reality check, 1 Oct 2026 ([Oracle free tier](https://www.oracle.com/cloud/free/)):
the Always Free ARM (Ampere A1) box is **2 OCPU / 12 GB / up to 200 GB** — plenty
— but **capacity is the hard part**: "out of host capacity" is common and some
people retry for days. Pick home region **Singapore** (closest, provisions more
reliably than US regions). A card is needed for identity; Always Free does not
charge. You become the database administrator (backups, patching, uptime), and
sign-in has a single point of failure only if you also move Auth (this plan does
not).

Steps (about a weekend, much of it waiting):

1. **Get the box.** Oracle Cloud sign-up, home region Singapore. Create an
   Ampere A1 VM, 2 OCPU / 12 GB, Ubuntu. Retry the create until capacity lands.
2. **Install** Postgres 17 + pgvector, and PostgREST (two containers).
3. **Expose it** with `cloudflared` — a Tunnel to PostgREST at `/rest/v1`, so it
   has an HTTPS address without opening ports.
4. **Schema.** Apply the job-table migrations from `src/db/migrations/` with
   `npm run migrate` pointed at the new box — including
   `2026-10-01-feed-family-fast.sql` and every `feed_*` function.
5. **Copy data.** `pg_dump` / `pg_restore` the job tables only (`jobs`, `boards`,
   `exclusions`, `facet_snapshot`, `crawl_runs`, …). Leave `user_state`,
   `app_seats`, `job_events` and the résumé bucket on Supabase.
6. **Point the code.** A second Supabase client for the user-data files
   (`src/state/store.ts`, `app/api/admin/route.ts`,
   `app/api/profile/resume-file/route.ts`); `db()` / `dbWrite()` in
   `src/db/supabase.ts` point at Oracle. New URL + keys as Worker secrets and
   GitHub Actions secrets, the way `SUPABASE_SECRET_KEY` already is.
7. **Prove it.** Run a crawl against Oracle; compare row counts with Supabase.
   Run the warm script; confirm the family tabs are `cf=HIT` and the origin is
   fast cold.
8. **Cut over.** Switch the site. Keep the Supabase job tables for a week as a
   rollback. Add a weekly Supabase ping (free projects pause when idle) and
   nightly Oracle backups off the box.

Rollback within the week: point `db()`/`dbWrite()` back at Supabase and redeploy.

Risks are catalogued in [database-hosting.md](database-hosting.md) (capacity,
region permanence, idle reclamation, you-run-it) — read that section before
starting; this runbook is the ordered steps, that file is the why.

---

## What NOT to do

- Don't move to Aiven/Neon free to save money — the free storage (0.5–1 GB)
  barely helps and you'd rewrite the PostgREST data layer to get there.
- Don't move Auth or Storage unless you have to; they are tiny and free where
  they are, and moving Auth means running an email sender.
- Don't skip the backup or the one-week rollback window on Path B.
