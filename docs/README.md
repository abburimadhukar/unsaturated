# Unsaturated — documentation

Start here.

| If you want to know | Read |
|---|---|
| How the code, the database and the workflows actually work | **[how-it-works.md](how-it-works.md)** |
| Where the project is, what was built, what is verified working | **[state-of-play.md](state-of-play.md)** |
| What is broken right now, ranked, with proof | **[outstanding.md](outstanding.md)** |
| What was deliberately set aside, and how to pick it up | **[parked.md](parked.md)** |
| How to start a fresh session on any of it | **[handoff.md](handoff.md)** |
| Where more job boards can come from | **[corpus-growth.md](corpus-growth.md)** |
| Where the database should live once it outgrows the free plan | **[database-hosting.md](database-hosting.md)** |
| The raw numbers behind all of the above | **[evidence/](evidence/)** |

---

## The two-minute version

Unsaturated reads jobs directly from employers' own hiring systems — Workday,
Greenhouse, Ashby, Oracle Cloud and twelve others — rather than from any job
board. It crawls 29,619 company career boards, classifies each role, and
surfaces the ones nobody else is showing.

As of 17 September 2026: **84,637 open postings**, 45,455 of them classified
into a family and browsable. The site is live, the test suite is green (1,331
tests, 0 failing), and the pipeline runs on free infrastructure.

The single most valuable next piece of work is
[outstanding.md §1](outstanding.md) — 712 stale copies of postings are open,
214 of them jobs the employer has already withdrawn, because a retired board's
postings are never closed. [handoff.md Phase 2](handoff.md) is the prompt for it.

---

## About the evidence

`docs/evidence/*.json` are point-in-time measurements of the live system, taken
7 and 17 September 2026. **Numbers in the four documents above come from those
files**, or are marked *(SQL, 17 Sep)* where they were measured directly, so
nothing has to be taken on trust.

Regenerate them with:

```
node docs/evidence/collect.mjs
```

It is read-only — it uses the same publishable key `src/db/supabase.ts` defaults
to, so it cannot write anything even by accident. It re-measures the corpus, the
board registry, seed coverage, the live site and the recent Actions runs, and
writes files named for today's date.

Two files are **not** regenerated, on purpose:

- `2026-09-07-session-ledger.json` — a record of what was committed and tested
  on that day. It is history, not a measurement.
- Anything needing the Supabase **service** key — `user_state`, the storage
  bucket. That key never belongs in a file.

If you are reading this well after September 2026, re-run the collector before
relying on any figure.

---

## Ground rules this project is built on

Several of the decisions in `parked.md` only make sense in light of these.

1. **Nothing is invented.** No fabricated match scores, no guessed salaries, no
   made-up employer detail. A missing value shows as missing.
2. **Freshness is the product.** The one job posted in that hour is the one that
   counts. This is why crawling low-yield boards less often was proposed and
   rejected.
3. **A refusal is not a death.** Written into the crawler after treating them
   alike cost 2,185 live boards, and later 46 more before it was fixed.
4. **Read the postings before changing a rule.** Every classifier fix in this
   project came from reading real adverts. The Institutions page is ~30% right
   precisely because its rules were validated against Cornell and startups and
   never against an ordinary employer.
5. **Push and deploy are two separate permissions**, and neither is implied by
   "fix it".
