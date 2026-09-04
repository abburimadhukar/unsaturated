# Unsaturated

A job board that reads jobs **straight from employers**, not from other job sites.

**Live: https://unsaturated-jobs.netlify.app**

```
1,437 companies watched   ·   22,500 jobs read every hour
3,515 kept   ·   software 1,642 · cloud 1,015 · data 830 · HRIS 28
Runs by itself. Costs nothing.
```

---

## The idea, in one paragraph

Almost every job site copies from other job sites. Copies go stale, lose the
original posting time, and send you through a middleman. This reads each
employer's own careers page directly — the same page their recruiter posts to —
so the data is first-hand and the "posted 2 hours ago" is genuinely 2 hours ago.

---

## How it works

Three separate pieces. None of them depends on your laptop being on.

```
┌── GITHUB ──────────────── wakes up every hour ────────────┐
│                                                            │
│   reads 1,437 company job pages      (~90 seconds)        │
│   throws away anything over 3 weeks old                   │
│   throws away anything not in your 4 job families         │
│   works out pay, seniority, country, skills               │
│   writes what is left to the database                     │
│                                                            │
└────────────────────────────────────────────────────────────┘
                            │ writes
                            ▼
┌── SUPABASE (database) ──── always on ──────────────────────┐
│   the jobs · your resume skills · what you have opened     │
└────────────────────────────────────────────────────────────┘
                            │ reads
                            ▼
┌── NETLIFY (the website) ── always on ──────────────────────┐
│   asks the database, draws the page  (~50 milliseconds)    │
│   never crawls anything itself                             │
└────────────────────────────────────────────────────────────┘
```

**Why split it up?** If the website did the crawling, every visitor would wait
90 seconds and the free hosting would time out at 30. Separated, the slow work
happens on a schedule in the background and the website only ever does a fast
database read.

---

## Step 1 — Finding companies

You cannot read a company's job page without knowing its address. That address
is not the company website; it is an account on whichever job-software vendor
they rent. Four ways of finding those, in order of how well they work:

| How | What it does | Success rate |
|---|---|---|
| **Hacker News threads** | People post their own board links in the monthly "Who is hiring?" thread. Exact addresses, no guessing. | **67%** |
| **Company-name guessing** | Turn "Vercel" into `vercel` and test it against every vendor. | 26–56% |
| **Reading careers pages** | Fetch `company.com/careers` and see which vendor it links to. | **22%** on universities, where guessing gets 7% |
| **Free job APIs** | Six keyless APIs that carry company *names* (not addresses) to feed the guesser. | 809 names → 425 boards |

Guessing works for startups (`Vercel` → `vercel`) and fails for everyone else.
Ohio State's account is called `osu` with a site named `OSUCareers` — no rule
invents that, but their careers page says it plainly. That is why the reader
exists.

---

## Step 2 — Reading the jobs

Eleven vendors, each with a different format, all translated into one shape:

```
Greenhouse · Lever · Ashby · Workable · SmartRecruiters
Breezy · Personio · Workday · Rippling · USAJobs · Socrata
```

**Workday matters most.** It is where banks, hospitals, defence firms and
universities live — the employers most job seekers never look at. It is also the
most awkward to read (a different request style, and each company hides its
listings behind a differently-named site), which is precisely why competitors
skip it.

Two of them are government: **Socrata** (US cities publish vacancies as open
data — full descriptions, real salaries, no key needed) and **USAJobs** (every
federal opening; written and ready, but dormant until someone adds a free key).

---

## Step 3 — Deciding what counts

Only four kinds of job are kept:

| Family | What goes in it |
|---|---|
| **Cloud & Infrastructure** | DevOps, SRE, platform, infrastructure, systems, network, cloud security, storage, NOC |
| **Software Engineering** | backend, frontend, full-stack, Python, APIs, web, applications |
| **Data** | data engineering, analytics, BI, data science, ML engineering, databases |
| **HRIS** | HRIS analysts, Workday/SuccessFactors consultants, HR systems, payroll systems |

**AI is a tag, not a family.** AI infrastructure is a cloud job, ML engineering is
a data job, LLM app work is a software job. They are labelled, not separated.

**Two signals, checked in order: the title, then the tools.**

The title is tried first, against a list of every name the same job goes by —
DevOps Engineer, SRE, Platform Engineer and Infrastructure Engineer are one role
under four fashions. Measured on a million-job index, "devops engineer" and
"kubernetes engineer" return near-identical counts because they are the same
population.

But titles lie. A job called "Software Engineer" whose description is all Spark,
Airflow and Snowflake is a data role. So when a title matches a family and the
description clearly points somewhere else, the tools win.

And when the title says nothing useful — "Member of Technical Staff", "Staff
Engineer" — the tools decide on their own.

HRIS is the exception: its titles are authoritative and never overridden,
because those roles are defined by the product someone administers rather than
by a tech stack, so they carry no tool fingerprint at all.

### Then: what kind of job is it?

A family holds thousands of postings, so each one is split again into a
**specialization**. A specialization belongs to exactly one family — a software
job can never come out as DevOps/SRE — and is only decided after the family is.

| Family | Specializations |
|---|---|
| **Cloud & Infrastructure** | DevOps/SRE · Platform Engineering · Cloud Infrastructure · Networking · Cloud Security · Systems/Storage · FinOps · General Cloud |
| **Software Engineering** | Frontend · Backend · Full-stack · Mobile · QA/Test Automation · Application/Integration · Embedded/Systems · General Software |
| **Data** | Data Engineering · Analytics/BI · Data Science · ML Engineering · MLOps · Database Administration · General Data |
| **HRIS** | Workday · SuccessFactors · Oracle HCM/PeopleSoft · UKG/Kronos · Payroll/Benefits · General HRIS |

**The title decides; the description only breaks a tie.** A title is a deliberate
statement about the job. A description is a wish list that mentions React in a
backend posting. So description terms are read only when the title is generic —
and then only when one specialization shows at least two distinct terms and two
more than the runner-up. Below that bar, nothing is written.

**"Unknown specialization" is a real answer, stored as NULL.** About a fifth of
postings carry no description at all, and plenty of titles are just "Engineer
II". Guessing would make every count on the site a small lie — the same mistake
the country filter used to make by folding undecoded locations into every
country. Unknown jobs stay visible; they only disappear if you filter them out.

The distinction between *general* and *unknown* is worth stating: "Software
Engineer" genuinely **is** general software work, so it gets `general_software`.
"Marketing Analyst" reached the data family on its SQL and never said what kind
of data job it is, so it gets NULL.

---

## Step 4 — Filling in the blanks

Employers leave a lot out. Rather than show gaps, these are worked out:

- **Salary** — only one vendor publishes it as a proper field. The rest write it
  in the description, so it is read out of the text. A wrong salary is worse than
  none, so a figure is only accepted with a currency or pay-context signal *and* a
  believable range. `$50M Series C` and `401(k) up to $5,000` are correctly ignored.
- **Seniority** — the title often does not say, but the description almost always
  does. "8+ years of experience" means staff level even when the title is just
  "Software Engineer".
- **Country** — Workday gives one messy line of text with no country field. State
  codes, country names and offshore city names are all recognised.
- **Location tidying** — `7000 Target Pkwy N,NCD-0375 Brooklyn Park,MN 55445`
  becomes `Brooklyn Park, MN`.

**Unknowns are shown, never hidden.** If we cannot work something out, the card
says `level unknown` rather than leaving a gap — and filtering by seniority still
*includes* those jobs rather than silently dropping them. A filter that quietly
hides 400 jobs is a filter that lies.

---

## Using the site

1. **Pick a family** from the tabs across the top
2. **Narrow it** in the sidebar — country, on-site/remote, seniority, employment
   type, posted-within
3. **Paste your resume** (top right) — skills are pulled out and every job then
   shows a match score with its evidence: `70% match · 7/10` means the job listed
   10 skills and you have 7
4. **Sort** by newest, best match, or salary
5. **Click a title** to open the employer's real posting and apply there

Ghost jobs — postings that reappear forever and are probably not real — are
flagged, not deleted.

---

## Running it yourself

```bash
npm install
npm run dev          # http://localhost:3000

npm run probe        # check all 11 readers still work
npm run typecheck
```

Finding more companies:

```bash
npm run harvest:hn      # Hacker News hiring threads
npm run harvest:names   # company names from free job APIs
npm run detect          # read careers pages directly
npm run discover        # guess names against every vendor
```

Crawling:

```bash
npm run crawl:db        # crawl everything, write to the database
npm run snapshot        # crawl and bake a local fallback file
```

Tests:

```bash
npm test                # classification, filter state, feed API
```

The API tests that assert what Postgres returns skip, loudly, until the
specialization migration is applied — a skipped test that says why is worth more
than one that passes by not looking.

### Database migrations

Applied by hand, never by the application. `src/db/schema.sql` describes the
schema as it actually exists; `src/db/migrations/` holds the change sets.

To apply `src/db/migrations/2026-09-04-specialization.sql`:

1. Supabase dashboard → **SQL Editor** → **New query**.
2. Paste the whole file and **Run**. It is safe to re-run: every step is
   `if not exists`, and the two feed functions are dropped by signature before
   being recreated — a bare `create or replace` would leave the old overload
   behind and make every RPC call ambiguous.
3. Confirm the columns landed:

   ```sql
   select column_name from information_schema.columns
   where table_name = 'jobs'
     and column_name in ('specialization','classification_version','specialization_reason');
   ```

4. Backfill the jobs already in the table:

   ```bash
   npm run backfill:spec -- --dry-run    # see the split before writing
   npm run backfill:spec                 # write it
   ```

   Restartable: rows already stamped with the current rules version are skipped,
   so interrupting it and running it again resumes rather than starting over. It
   never writes `crawl_runs` and never touches `last_seen_at`, so it cannot mark
   a stale corpus fresh.

   It classifies from the **title only** — descriptions are fetched during a
   crawl and never stored, so there is nothing here to read. Generic titles are
   left NULL and the next crawl, which does have the description, improves them.

---

## What it costs

**Nothing, permanently.** Not a trial.

| | |
|---|---|
| GitHub Actions | free and unlimited on a public repo |
| Supabase | free tier — 500 MB, using a fraction of it |
| Netlify | free tier |

---

## Known gaps

- **HRIS is thin (28 roles).** Those jobs live in government and large
  enterprises, not the tech companies that make up most of the corpus. USAJobs
  would fix it and needs a free key.
- **Duplicates.** One role posted across ten locations shows as ten rows.
- **Scheduling is unreliable.** GitHub delays and sometimes drops scheduled runs.
  Mitigated with three attempts an hour plus a guard that makes the extra ones
  exit in seconds, but it is not perfect.
- **Nobody has checked whether the jobs are actually good.** Every rule and
  threshold was tuned against measurements, not against a real job seeker's
  judgement.

---

## How the code is laid out

```
src/ats/          reading the vendors — one file per vendor,
                  plus salary parsing, country detection, tidying
src/discovery/    the four ways of finding companies
src/taxonomy/     deciding which of the four families a job is
src/scoring/      resume matching, ghost-job detection
src/corpus/       running the crawl, reading and writing the database
src/cli/          the commands above
app/              the website and its API
.github/          crawl.yml (hourly)  ·  deploy.yml (on every push)
```

Adding a new vendor is one file and one line in a registry. Nothing downstream
knows which vendor a job came from.
