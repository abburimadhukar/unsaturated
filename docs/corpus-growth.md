# Growing the corpus — what is left, and what has been ruled out

Working notes, 6 September 2026. Everything here was measured, not guessed; the
numbers are kept so nobody has to re-measure them.

Pick this up **after** discovery run
[34035258006](https://github.com/abburimadhukar/unsaturated/actions/runs/34035258006)
finishes, because it changes the ranking below.

---

## Where the corpus stands

```
23,864  active boards
60,239  open jobs
32,525  classified into a family
    11  hiring systems connected
```

Roughly 2.5 open jobs per board. 3,913 active boards (16%) returned zero jobs
at verification — real companies with nothing open right now. Not a growth
lever, but it means a sixth of the registry contributes nothing on any given
day.

---

## 0. Already unlocked, not yet measured

The Common Crawl fix shipped in `8aea66f` on 6 Sep.

Until that landed, all eleven jobs in the discovery matrix downloaded the
**entire** catalogue — every pattern for every vendor — and discarded all but
their own. Eleven times the load for one eleventh of the value. Common Crawl
throttled us, refused pages were skipped **silently**, and every run walked away
with a different partial slice while reporting success.

Evidence from a single run:

```
*.jobs.personio.de/*     0 urls -> 0 new      CDX 502, 504, 503
*.recruitee.com/*        0 urls -> 0 new      CDX 504
*.bamboohr.com/*         2,388 / 2,410 / 9,154 / 12,110 urls
                         ↑ same pattern, four jobs, one run, four answers
```

That is why Greenhouse offered 701 candidates one run and 44 the next, and why
Airbnb, Adyen, Affirm and Airtable are live, present in the catalogue, and still
unregistered.

**We have never seen a complete catalogue.** The run above is the first honest
count. Do not plan against the numbers below until it lands — the answer could
be a few hundred boards or a few thousand.

---

## 1. Free wins — adapter exists, discovery never wired

Four providers have working adapters and **no Common Crawl pattern at all**, so
they only ever hold the handful of boards typed in by hand months ago.

### Rippling — do this one

`ats.rippling.com`, 1 index page. Currently **4 boards**.

Addresses are as clean as Greenhouse's — company name is the first path
segment:

```
ats.rippling.com/514-careers/jobs/5811104e-78bb-4aaa-a8f6-32bbad47654b
ats.rippling.com/aaca/jobs/51f21f69-d573-4971-8759-b43d3dd6ce23
ats.rippling.com/a20-opportunities-page/jobs
```

The adapter (`src/ats/adapters/rippling.ts`) and a verifier entry both already
exist. **This is one pattern in `commoncrawl.ts` and a line in the discovery
matrix.**

### Breezy — looked easy, is not

`*.breezy.hr`, 2 index pages, currently 21 boards. But page one is almost
entirely Breezy's own marketing site rather than customer boards:

```
https://breezy.hr/
https://breezy.hr/?utm_medium=…&utm_campaign=Partner
```

Company boards live at `{company}.breezy.hr` and barely appear in the sample.
Worth a deeper look at page 2 before spending time on it.

### USAJobs and Socrata — nothing to discover

Not multi-tenant. One US federal API and one NYC open-data feed. Their adapters
are correct as they are.

---

## 2. Workday has a second domain we never look at

We harvest `myworkdayjobs.com`. Workday **also** serves boards from
`myworkdaysite.com`, and no pattern covers it.

From one page of the index: **168 distinct tenant/site pairs**, including

```
Clorox · Fidelity · White & Case · Becton Dickinson · Banijay · AssetWorks
```

Same adapter and same API (`{host}/wday/cxs/{tenant}/{site}/jobs`) — only the
address is shaped differently. The tenant sits in the **path** rather than the
subdomain, and there are two variants:

```
wd1.myworkdaysite.com/de-DE/recruiting/whitecase/External/job/…
wd1.myworkdaysite.com/en-US/Clorox/job/…
```

So the extraction needs to handle the optional `recruiting/` segment and the
optional locale. Note the existing Workday pattern already learned this lesson
once: mistaking the locale (`en-US`) for the site name dropped live verification
from 11/12 to 4/10.

**A new pattern, not a new integration.**

---

## 3. New systems, sized by their footprint in the catalogue

Measured against CC-MAIN-2026-34 with `showNumPages=true`:

| System | Pages | Blocks | Verdict |
|---|---|---|---|
| iCIMS | 4 | 16 | Biggest of all. Previously ruled out; the note does not say why. **Re-test before dismissing again.** |
| Oracle Cloud Recruiting | 3 | 13 | Largest genuinely untapped. Heavy in universities, hospitals and government — feeds the Institutions page directly. |
| Breezy | 2 | 8 | See above — mostly marketing pages. |
| Jobvite | 2 | 7 | Browser-rendered, no API. Ruled out. |
| Paylocity | 1 | 5 | Ruled out previously. |
| Rippling | 1 | 4 | Adapter exists — see §1. |
| JazzHR (`applytojob.com`) | 1 | 3 | Browser-rendered. Ruled out previously. |
| Workday second domain | 1 | 2 | See §2. |
| ADP WorkforceNow | 1 | 2 | Unexplored. US mid-market. |
| SAP SuccessFactors | 1 | 1 | Too small to be worth an adapter. |
| Pinpoint | 1 | 1 | Too small. |

**Oracle Cloud Recruiting is the only large system worth building an adapter
for**, and it lands squarely in the institutional employers the Institutions
page exists to surface.

---

## 4. The multiplier nobody has tried

We read **one** monthly snapshot of Common Crawl. There are about **127**.

Older snapshots were dismissed earlier at roughly 10% still-alive, which sounded
poor. But that judgement was made when every worker downloaded all thirteen
patterns. Now each reads one or two, so **reading four snapshots costs less than
reading one used to**.

10% of four extra snapshots is not nothing, and a board that existed two years
ago and is *still answering today* is exactly the kind we are missing — it has
had years to fall out of the current snapshot while remaining perfectly live.

Cheapest test: run one provider against one older collection with
`--crawl CC-MAIN-2025-…` and count how many verify live.

---

## Ruled out, with reasons — do not re-derive these

- **No ATS publishes a customer directory.** Greenhouse's docs offer
  unauthenticated reads with no way to ask who its customers are. TheirStack,
  who sell this data, say plainly that public ATS APIs do not list their clients.
- **No ATS publishes sitemaps.**
- **Lever is absent from Common Crawl on purpose.** `jobs.lever.co/robots.txt`
  carries `User-agent: CCBot / Disallow: /`, so the index holds 62 URLs for
  Lever and all of them are the robots file. Lever tokens come from the open
  dataset instead. Reading their boards directly is what their `User-agent: *`
  rule permits.
- **Jobvite, JazzHR, Homerun, Join.com** — browser-rendered, no JSON endpoint.
- **Paylocity, iCIMS** — previously judged not viable. iCIMS has the largest
  footprint of anything unconnected, so this deserves one re-test rather than
  permanent dismissal.

---

## Order of work

1. **Wait for the run in flight.** It changes every number above.
2. **Rippling pattern** — an hour, against an adapter that already runs.
3. **Workday's second domain** — same adapter, ~168 employers, recognisable names.
4. **Two or three older snapshots** — now affordable, and the widest net available.
5. **Oracle Cloud adapter** — the only large build, and it feeds Institutions.

Steps 2–4 are pattern work against code that already exists. Step 5 is the only
real integration.
