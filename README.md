# Unsaturated

A job board that reads jobs **straight from employers**, not from other job sites.

**Live: https://unsaturated-jobs.netlify.app**

```
1,437 companies watched   ·   22,500 jobs read every hour
3,535 kept   ·   software 1,797 · cloud 902 · data 808 · HRIS 28
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
