# Growing the corpus — what is left, and what has been ruled out

Working notes. Everything here was measured, not guessed, and the numbers are
kept so nobody has to re-measure them.

**Re-measured 15 September 2026.** The previous version of this file was written
on 6–7 September, before the Common Crawl throttling fix had been observed and
before anything below had been verified against a live vendor. Two of its
sections turned out to be wrong; both are corrected in place rather than
quietly deleted, because the wrong answer is the useful part.

---

## Where the corpus stands

Measured 15 September 2026 against the live database.

```
27,275  boards            26,912 active, 363 retired
65,205  open jobs         35,829 classified into a family
 9,359  companies with something open right now
    12  hiring systems contributing boards
   282  MB of the 500 MB Supabase free tier
```

| provider | active boards | open jobs | per board |
|---|---:|---:|---:|
| workday | 4,104 | 27,583 | 6.72 |
| greenhouse | 5,697 | 13,551 | 2.38 |
| ashby | 3,142 | 7,450 | 2.37 |
| smartrecruiters | 853 | 5,192 | 6.09 |
| workable | 3,045 | 2,498 | 0.82 |
| lever | 1,969 | 2,419 | 1.23 |
| ukg | 1,514 | 2,033 | 1.34 |
| rippling | 910 | 1,809 | 1.99 |
| teamtailor | 869 | 1,159 | 1.33 |
| bamboohr | 2,918 | 713 | 0.24 |
| recruitee | 525 | 417 | 0.79 |
| personio | 1,344 | 340 | 0.25 |

---

## 0. The number that should frame every decision below

**Board count is not the constraint.** We watch 26,912 boards; 9,359 companies
have anything open that this site is for. 14,899 active boards have never
produced a single job row.

That is not a fault. Each full sweep reads about 405,000 postings and keeps
**17.3%** — the rest are maintenance technicians, retail associates, nurses and
store managers. Advance Auto Parts, Wendy's and Big Lots are all registered, all
crawled, and all correctly contributing nothing.

It was worth checking whether the filter over-eats, and it does not: of 157,413
distinct titles in the "no family matched" bucket, **547** look software-shaped
— 0.3%. Two small gaps are real and worth a look on their own: `Security
Engineer` and `Software Quality Engineer` are both being dropped.

So a new source is worth what its **in-family** postings are worth, not what its
board count is. Oracle at 108 postings a board beats a thousand BambooHR boards
at 0.24.

---

## 0b. Workable is a Cloudflare challenge — settled, do not reopen

**Closed 7 September 2026. The evidence is here so nobody spends another day on it.**

Workable refuses roughly 3,000 boards on every sweep — which is the size of the
entire Workable estate, and the whole of the crawl's 11% failure rate. Slowing to
the limiter's floor did not touch it. The crawler captures what a vendor says
when it refuses, and Workable named itself:

```
status 429 · cf-mitigated: challenge · server: cloudflare
             <title>Security challenge</title>
```

`cf-mitigated: challenge` is Cloudflare bot management, not a rate limiter.
Workable's API documents `X-Rate-Limit-Remaining` and `X-Rate-Limit-Reset`; none
were present, and the body is an HTML challenge page carrying `noindex`.

**Why there is no fix worth taking:** sending a browser `User-Agent` contradicts
this project's own honest-user-agent rule and is an arms race against a company
whose business is winning it; Workable's official API issues tokens per
employer, so there is no key covering 3,000 of them; and running the lane from
another IP means leaving GitHub Actions, which is the only infrastructure this
project has.

**Why it barely matters.** Workable is 11% of the registry and 3.8% of the open
jobs, at 0.82 postings per board — the second-weakest provider we have even when
read perfectly. The boards stay registered, the few hundred that get through
each hour still update, and nothing degrades. **Leave it.**

---

## 1. Done since the last revision of this file

- **Rippling** — pattern wired 9 Sep. Went from 4 boards to 910, now 1,809 open
  jobs.
- **SmartRecruiters' `careers.` domain** — wired 7 Sep.
- **Oracle Cloud Recruiting** — adapter, pattern and discovery matrix, 15 Sep.
  See §2.
- **The Internet Archive as a second index** — 15 Sep. See §3.
- **Workday tenant names from `myworkdaysite.com`** — 15 Sep, though not in the
  way the old §2 of this file proposed. See §4.

---

## 2. Oracle Cloud Recruiting — the biggest thing that was missing

`{tenant}.fa.{pod}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/{site}/job/{id}`

Measured 15 September 2026 against CC-MAIN-2026-34:

```
indexed urls read                      38,335
boards found that nobody held           1,170
sampled and verified live               25 of 25   (HTTP 200, no key, no session)
postings behind that sample             2,710      — 108 per board
```

108 per board against Workday's 6.7 and Greenhouse's 2.4. Its customers are
hospitals, universities, utilities, government and large European manufacturers
— Pearson, Amplifon, Parkland Hospital, Daher — which is exactly the
uncontested half of the market this project exists to surface.

**Three things about it worth knowing before touching the code.**

The tenant is an opaque four-letter code. `hccz` is Pearson and `efuf` is
Amplifon; no naming rule reaches either. The name is read from the career
site's own page title, falling back to the first entry of `organizationsFacet`
(ordered by posting count, so the parent). An earlier rule trusted the facet only
when it named exactly one organisation, and it named almost nobody — see §7.

The listing carries no description at all — not a truncated one, an empty
string — so Oracle is a `BACKFILLABLE` provider like Workday and
SmartRecruiters, and its body text comes from `recruitingCEJobRequisitionDetails`
per posting.

The page limit is 200 whatever you ask for. Asking for 300 returns 200, so a
paginator built on the requested size reads the same page forever.

Against one real board (Pearson, 394 postings): 2 pages in 5.1 seconds, 100% with
the employer's own date, 96% with a workplace type, and 61 of 394 classified into
a family — 15.5%, in line with the corpus-wide 17.3%.

---

## 3. The Internet Archive — a second index, and a continuously updated one

**Common Crawl had published nothing for five weeks.** CC-MAIN-2026-34 is dated
late August and was still the newest collection on 15 September, so the weekly
discovery job had been re-reading the same index every Sunday and finding, by
construction, nothing. An index that moves monthly cannot keep a registry
current in between.

`web.archive.org/cdx/search/cdx` covers the same ground and is written to
continuously. Measured on captures since 1 June 2026:

| provider | tokens | unregistered | live rate | jobs per sampled token |
|---|---:|---:|---:|---:|
| greenhouse | 3,658 | 525 | 68% | 10.1 |
| ashby | 3,480 | 996 | 50% | 3.5 |
| rippling | 695 | 341 | 90% | 8.1 |
| workday | — | — | — | robots-excluded |
| lever | — | — | — | robots-excluded |

It uses the **same pattern table and the same extraction** as the Common Crawl
harvest, deliberately: two lists would drift, and a vendor found by one index and
silently not the other is the failure the single pattern table was written to
prevent.

**Two API behaviours that cost an afternoon, both now in tests.**

A trailing `*` and an explicit `matchType=prefix` cannot be combined.
`url=jobs.ashbyhq.com*&matchType=prefix` returns **zero** rows;
`url=jobs.ashbyhq.com&matchType=prefix` returns 37,656. Zero is also what a
robots-excluded host returns, so the mistake reads as "Ashby is not in the
Archive" rather than as a broken query.

`limit` is applied **before** `collapse=urlkey`, and rows come back sorted by
urlkey. So a small limit reads thousands of near-identical urls from a handful of
boards: Ashby at `limit=4,000` collapses to 7 distinct urls, at `limit=150,000`
to 37,656. Turning the limit down to be polite does not read less of the archive,
it reads the same start of it and throws the discovery away.

`matchType=domain` is not usable — it times out with a 504 on any domain of
size. `*.host` does the same job and answers. `*.oraclecloud.com` 504s either
way, three times over at 61 seconds each, so it is on an explicit skip list with
that measurement written next to it; Oracle comes from Common Crawl, which pages
by block.

---

## 4. Workday's second domain — the old §2 was wrong

The previous version of this file said `myworkdaysite.com` was a second estate of
about 168 employers that we never looked at, and ranked adding a pattern for it
second. **That was wrong, and adding that pattern naively would have created
duplicates.**

Both hostnames serve the *same board*. Measured 15 September, asking each for
the same tenant and site:

```
tenant/site                     myworkdayjobs   myworkdaysite
fmr/FidelityCareers                      636             636
wf/WellsFargoJobs                       1792            1792
ssctech/SSCTechnologies                  331             331
parexel/Parexel_External_Careers         347             347
tjx/TJX_External                       11001           11001
avnet/External                           271             271
```

Fidelity, Wells Fargo, TJX and Parexel are already in the corpus. Registering
them again under a second host is precisely the duplicate the 2026-09-07 site
migration exists to prevent.

**What those URLs are actually good for is tenant names.** Of 58 tenants found
there, 38 were in no registry at all — HCA Healthcare, Clorox, BSI Group, Daher,
Parkland Hospital, White & Case. They were never discovered, not badly
addressed.

And the hostname must be thrown away, because the `wd1` in
`wd1.myworkdaysite.com` is the site's front door rather than the tenant's shard.
Of eight unregistered tenants checked, three answered on `wd3` and `wd12`:

```
clorox/Clorox                      wd1  (192)
baird/Careers                      wd1  (111)
whitecase/External                 wd1  (149)
bsigroup/BSI_Careers               wd3  (251)
daher/Daher                        wd3  (274)
parklandhospital/Parkland_Careers  wd12 (322)
heihotels/External_Career_Site     wd12 (477)
carislifesciences/CLS              wd12 (145)
```

Taking the address at face value would have recorded five of those eight as
dead. So the harvest stores the tenant and the site with **no host**, and
verification finds the shard on `myworkdayjobs.com` — the domain we already
crawl. `scripts/workday-site-check.mts` walks exactly that path against the live
vendor.

Worth about 1,300 kept jobs after the family filter, not the ~7,000 the old
section implied: most of what it counted, we already had.

---

## 5. Ruled out, measured, with the numbers

**Older Common Crawl snapshots — the old §4 called this "the multiplier nobody
has tried". It is a dud.** 60 tokens from CC-MAIN-2024-38 that the registry did
not hold:

```
live (HTTP 200)     3   (5%)
gone (HTTP 404)    57
open jobs behind the live ones:  0
```

The extraction is not in doubt — 1,005 of the 1,705 tokens on that page were
already registered, so the method works and the residue really is dead. A board
that vanished two years ago is gone. This is why the Archive harvest defaults to
captures from the last three months.

**Certificate Transparency — ruled out.** The idea was to enumerate customer
subdomains from CT logs. Vendors use wildcard certificates, so customers never
appear: crt.sh returns 38 hostnames for `eightfold.ai` against Common Crawl's
102.

**No ATS publishes a customer directory.** Greenhouse's docs offer
unauthenticated reads with no way to ask who its customers are. TheirStack, who
sell this data, say plainly that public ATS APIs do not list their clients.
Oracle is the same: `/v1/companies`, `/v1/companies/search` and `/sr-api/companies`
all 404 on SmartRecruiters, and Oracle has no site-metadata resource at all —
`recruitingCESites`, `recruitingCESiteDetails` and `recruitingCEBrandings` answer
400, 404 and 404.

**No ATS publishes sitemaps.**

**Lever is absent from Common Crawl on purpose.** `jobs.lever.co/robots.txt`
carries `User-agent: CCBot / Disallow: /`, so the index holds 62 URLs and all of
them are the robots file. The Internet Archive is excluded too. Lever tokens come
from the open dataset instead; reading their boards directly is what their
`User-agent: *` rule permits.

**Jobvite, JazzHR, Homerun, Join.com** — browser-rendered, no JSON endpoint.

---

## 6. What is left, sized

Measured 15 September 2026 against CC-MAIN-2026-34 unless stated.

| System | Footprint | JSON? | Verdict |
|---|---|---|---|
| **iCIMS** | 4 pages, 16 blocks; 692 hosts on page 0 alone, so ~2,000–2,800 boards | **No** | The largest thing left. Tested directly: `?in_iframe=1` returns server-rendered HTML with a parseable job table; `format=rss` and `format=json` both return HTML. It would be the first HTML scraper in the codebase, which is the whole decision. |
| **Eightfold** | 1 page, 3 blocks; 102 hosts on page 0 | **Yes** | Keyless JSON confirmed — Bayer returned `count: 603` from one call. Tenants are blue chips: Amex, Amgen, AstraZeneca, Bayer, BCG, BMS, BNY Mellon, Applied Materials. One wrinkle: the API needs each tenant's own domain as a parameter and 403s or 404s on a wrong guess, so domain resolution is the work. |
| **Paylocity** | 1 page, 4 blocks; 2,518 company GUIDs on page 0 | **No** | Server-rendered HTML. US mid-market, thin per board. Breadth without depth. |
| Jobvite | 2 pages, 7 blocks | No | Browser-rendered. Ruled out. |
| Avature | 2 pages, 6 blocks | Unknown | Unmeasured. |
| Taleo | 1 page, 3 blocks | Unknown | Oracle's legacy product; Oracle Cloud is the successor and is now connected. |
| JazzHR | 1 page, 3 blocks | No | Browser-rendered. Ruled out. |
| ADP WorkforceNow | 1 page, 2 blocks | Unknown | US mid-market. |
| SuccessFactors / Phenom / Pinpoint / Comeet / gr8people | 1 page, 1 block each | — | Too small to be worth an adapter. |
| Breezy | 2 pages, 8 blocks; 21 boards held | Yes, adapter exists | Page one of the index is Breezy's own marketing site. Worth a look at page two before spending time on it. |
| USAJobs | n/a | Yes, adapter written | **Switched off, and never once run.** Zero boards. Needs a free key from developer.usajobs.gov and two lines in `crawl.yml`. Deliberately excluded from the 15 Sep work at the owner's request. |

---

## 7. The ceiling, and it is closer than the opportunity

Two limits, both measured 15 September 2026.

**Crawl time.** A shard does 6,730 boards in ~23 minutes against a
`timeout-minutes: 40` budget, four shards in parallel. That is headroom to
roughly **46,000 boards** at the current shape. Oracle's 1,170 boards are a 4%
increase, which is comfortable; the next large source is not automatically so,
and Oracle's boards are 16× denser than the average, so requests grow faster
than rows.

**Disk.** The database is at **282 MB of the 500 MB free tier** — `jobs` alone
is 117 MB for 126,926 rows, about 0.92 KB a row. Oracle at ~19,500 expected
in-family postings adds roughly 18 MB. Two more sources that size and the tier
is the binding constraint, not the clock.

**Shards must keep an employer together — fixed 16 September 2026.** Crawl
shards were split by board position, so a tenant's career sites could land in
different shards. The close pass only closes a token when every board under it
was read, but a shard can only judge the boards it holds — so each shard saw one
healthy site and closed its siblings' postings, and the next upsert reopened
them. Measured: multi-site Workday tenants closed **170.8** postings per 100 open
in 48 hours against **15.1** for single-site ones, roughly 8,600 live jobs hidden
at any moment. Oracle's 156 multi-site tenants would have joined them.
`sliceForShard` now round-robins by tenant; `tests/shard-tenants.test.ts` fails
on the old split.

**Oracle names — repaired 16 September 2026.** The first discovery run stored
764 Oracle boards and named almost none, because the facet rule refused any
tenant listing subsidiaries. 503 were renamed from the career site's page title
(facet as fallback), plus 21 follow-up corrections. The previous values are in
`backups/oracle-names-2026-09-16.json` — local only, as `backups/` is gitignored. Six remain on their tenant code on
purpose: three the vendor would not name and three whose only candidate was a
cost-centre code. A few dozen carry a department rather than an employer
("Apparel", "Social Worker") — not reliably separable from a real name, and left.

**Cadence, separately.** The crawl advertises itself as hourly and in practice
runs every 2–6 hours: GitHub drops scheduled runs. Every active board carried a
`last_crawled_at` between 3 and 6 hours old when this was measured, with none
newer. Worth knowing before optimising anything for freshness.

---

## 8. Order of work

1. **Turn on USAJobs** — an adapter that already exists, has never run, and
   fills the documented HRIS gap. A free key and two lines of workflow.
2. **Eightfold** — 102 blue-chip tenants, keyless JSON already confirmed. The
   work is resolving each tenant's domain, not reading the API.
3. **Raise the shard count before anything large lands**, and watch the 500 MB.
4. **iCIMS** — the largest remaining, and the only one that requires deciding
   whether this codebase takes on an HTML scraper.

Workable is deliberately absent — see §0b. Older snapshots and Certificate
Transparency are deliberately absent — see §5. Both are closed.
