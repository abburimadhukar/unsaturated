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
| The raw numbers behind all of the above | **[evidence/](evidence/)** |

---

## The two-minute version

Unsaturated reads jobs directly from employers' own hiring systems — Workday,
Greenhouse, Ashby and nine others — rather than from any job board. It crawls
25,161 company career boards hourly, classifies each role, and surfaces the ones
nobody else is showing.

As of 7 September 2026: **60,750 open postings**, 32,643 of them classified into
a family and browsable. The site is live, the test suite is green, and the
pipeline runs on free infrastructure.

The single most valuable next piece of work is
[outstanding.md §1](outstanding.md) — 46 live companies are sitting retired,
holding about 7,877 jobs, because Workday refuses with an HTML page instead of
an HTTP status code and nothing recognises that as a refusal.

---

## About the evidence

`docs/evidence/*.json` is a point-in-time measurement of the live system taken
7 September 2026. **Every number quoted in the four documents above comes from
those files**, so nothing has to be taken on trust.

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
   alike cost 2,185 live boards. It is currently costing another 46 — see
   [outstanding.md §1](outstanding.md).
4. **Read the postings before changing a rule.** Every classifier fix in this
   project came from reading real adverts. The Institutions page is ~30% right
   precisely because its rules were validated against Cornell and startups and
   never against an ordinary employer.
5. **Push and deploy are two separate permissions**, and neither is implied by
   "fix it".
