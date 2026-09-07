# Parked work — what was set aside, and how to pick it up

Written 7 September 2026. Everything here was measured, not guessed. The numbers
are kept so nobody re-derives them, and each item says what is already known,
what the fix direction is, and what would have to be decided.

Corpus growth lives separately in [corpus-growth.md](corpus-growth.md).

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

## 4. Skills gap — AI and resume matching

**Parked earlier in the session, planned as a later piece of work.**

The intent was to show what a person is missing for a role, not only what they
match. The resume side now exists — pasted text and uploaded PDF/DOCX both
extract skills — so the input half is built.

Not started. No measurements taken.

---

## 5. Colour and profile detail

**Both parked earlier**, after the specific problems were fixed.

- **Colour**: the accent/danger clash was fixed and four page identities exist
  (feed orange, quiet teal, institutions blue, account violet), each checked for
  contrast in both themes. Anything further is preference, not correctness.
- **User details**: applied and seen counts are shown. Anything beyond that —
  saved searches, per-family activity, application history — was deferred.

---

## Not parked, just not done yet

These have no decision attached. They are simply outstanding.

| What | Status |
|---|---|
| **`/api/feed` returned 503** while `/quiet` and `/institutions` answered 200 in the same second | Found 7 Sep, uninvestigated. It is the only one going through the `feed_page` RPC rather than reading the table directly, so it is the slowest and likeliest to hit a statement timeout. **User-facing — the homepage showing no jobs.** |
| **96 boards at 3+ consecutive failures** | Harmless now that refusals cannot retire anything, but the reason is unknown. |
| **A crawl shard died on `canceling statement due to statement timeout`** during a job upsert, once, 6 Sep | Possibly the same root cause as the 503. |
| **The `resumes` storage bucket** | Never confirmed to exist. Resume uploads stay off until it does. Check with: `select id, public from storage.buckets where id = 'resumes';` |

---

## Settled — closed, not parked

Do not reopen these without new evidence.

- **Workable is a Cloudflare bot challenge**, not a rate limit. `cf-mitigated:
  challenge`, `server: cloudflare`, `<title>Security challenge</title>`, and
  none of the rate-limit headers its own API documents. Slowing to one request
  every four seconds still drew ~700 refusals per shard. See
  [corpus-growth.md §0b](corpus-growth.md).
- **Board scheduling by tier** — crawling low-yield boards less often. Proposed
  and rejected on the right grounds: freshness is the product, and a role found
  five hours late is the role someone else already applied to. Per-vendor lanes
  solved the underlying problem without skipping anything.
