# Application assistant — research and design

17 September 2026. A design, not an implementation: no code has been changed.

**Decision in one paragraph.** Unsaturated will not submit applications on
anyone's behalf. It will prepare each application in the web app — the résumé
version, the common answers, drafted answers to that job's own questions, and
the person's approval of anything important — and a browser extension will
fill that approved application into the employer's real form, in the person's
own browser, where **the person clicks Submit**. The extension then recognises
the vendor's confirmation page and records the application in the tracker.
People without the extension get the same prepared application as a
copy-and-paste kit. The first release covers Greenhouse and Ashby; Workday
follows as its own phase; together with SmartRecruiters those four are 81% of
the jobs the site shows.

---

## 1. What the codebase has today

| Area | Today | What it means for this feature |
|---|---|---|
| **Accounts** | Magic-link sign-in with a hard cap of **4 seats** (`src/state/auth.ts`, DB trigger). Signed-out visitors are an anonymous cookie. | Application data must be signed-in only — the same rule `app/api/profile/resume-file/route.ts` already applies to résumé files. |
| **Profile** | `user_state`: first/last name, extracted skills, `resume_text`, one résumé file (`resume_path`), a résumé embedding. No phone, location, links, work authorisation or any other application field. | Almost all of an applicant profile is new. |
| **Résumé** | One file per account in the private `resumes` bucket (PDF/DOCX/TXT/MD, 5 MB). `resume_text` is server-only. | "Which résumé did I send?" cannot be answered: there is one slot, and a tailored résumé is not stored anywhere. |
| **Tailoring** | Mature: `/tailor` workspace, suggestions, whole-résumé rewrite, a returned `.docx` of the person's own document (`src/tailor/*`, `app/api/tailor/*`). OpenAI Chat Completions, rate-limited per isolate (8 a minute). Rule: invent nothing, never silently delete. | The hardest content work already exists. It needs to *save* its output as a résumé version. |
| **Job descriptions** | Fetched on demand for 13 providers (`src/tailor/providers.ts`, `src/ats/describe.ts`). Not stored. | Answer drafting can read the posting the same way tailoring does. |
| **Application tracking** | `job_events(user_id, job_key, seen, applied, at)`. **Clicking a job title calls `open()` in `app/page.tsx`, which records `applied: true`.** | The tracker's data is wrong: **650 of 652 events are "applied"** across 11 visitors, because opening a posting is recorded as applying. There are no statuses, dates per status, notes, or record of what was sent. |
| **Apply links** | Every job has `apply_url` straight to the vendor (e.g. `job-boards.greenhouse.io/...`, `jobs.ashbyhq.com/.../application`, `*.myworkdayjobs.com/...`). | The extension's entry point already exists on every card. |
| **Security posture** | RLS enabled; the publishable key is SELECT-only; the site writes with a Worker secret. `resume_text` has no anon policy. | Good base. New tables follow the same pattern. |
| **Runtime** | Next.js on Cloudflare Workers; 10 ms CPU budget per request noted in the feed route; no filesystem. | No heavy work in requests. Headless browsers would need Cloudflare Browser Run — rejected below for other reasons. |

### Where the jobs are

Open, browsable jobs (in a real family) by vendor, 17 Sep *(SQL)* — 45,455 in total:

| Vendor | Jobs | Share | Running total |
|---|---:|---:|---:|
| Workday | 18,923 | 41.6% | 41.6% |
| Greenhouse | 8,531 | 18.8% | 60.4% |
| Ashby | 5,312 | 11.7% | 72.1% |
| SmartRecruiters | 3,984 | 8.8% | **80.9%** |
| Oracle Cloud | 1,879 | 4.1% | 85.0% |
| Lever | 1,640 | 3.6% | 88.6% |
| Workable | 1,429 | 3.1% | 91.7% |
| Rippling | 1,396 | 3.1% | 94.8% |
| UKG, Teamtailor, BambooHR, Recruitee, Personio, others | 2,361 | 5.2% | 100% |

Workday alone is two jobs in five, and it is the hardest form to fill. That
fact shapes the plan more than any other.

---

## 2. Research findings

### 2.1 Can a third party submit through the vendors' official APIs? No.

| Vendor | Official application endpoint | Who can use it |
|---|---|---|
| Greenhouse | `POST boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}` | Basic Auth with **the employer's** Job Board API key; must be proxied server-side because the key is secret. [docs](https://docs.greenhouse.io/job-board.html) |
| Lever | `POST /v0/postings/{site}/{id}?key=…` | An API key "a Super Admin of your account can generate"; 2 POSTs/second limit; dedupes by email. [docs](https://github.com/lever/postings-api) |
| Ashby | `applicationForm.submit` | Requires the `candidatesWrite` permission on the employer's API key. [docs](https://developers.ashbyhq.com/reference/applicationformsubmit) |
| Workable | `POST /jobs/:shortcode/candidates` | Account token with `w_candidates` scope. [docs](https://workable.readme.io/reference/job-candidates-create) |
| SmartRecruiters | Application API, `POST /postings/:uuid/candidates` | Customers, or partners with a Partner API key from the Partner Portal; integrator must show privacy consent, diversity questions separately and the AI disclosure. [docs](https://developers.smartrecruiters.com/docs/application-api-1), [partner key](https://developers.smartrecruiters.com/docs/partner-api-key) |
| Workday | No public candidate-side apply API. Candidates use a per-employer Candidate Home account; tenants may require an account or verify by email. [Workday admin guide](https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/career-sites/gtv1538650489786.html), [explainer](https://www.froghire.ai/blog/why-new-workday-account-each-employer) |

These APIs exist so an **employer** can build its own careers page. A job
seeker's tool holding thousands of employers' keys is not a thing that exists.
SmartRecruiters' partner programme is the only door that might open to a third
party (8.8% of jobs); it is worth an enquiry later, not a dependency.

### 2.2 What the vendors publish that helps

- **Greenhouse publishes every job's application questions without a key.**
  `GET boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true`
  returned, for a live Shift Technology job: name, email, phone, résumé, cover
  letter, *"Are you legally authorized to work in Canada…"*, *"Will you now or in
  the future require … visa sponsorship?"*, a commuting question, LinkedIn, a
  GDPR notice, plus `compliance` (EEOC), `demographic_questions`,
  `ai_disclaimer` and `ai_opt_out_request_url`. Tested 17 Sep.
  **So a Greenhouse application can be fully prepared and approved before the
  form is ever opened.**
- **Ashby's hosted page reads its form from a GraphQL endpoint**
  (`jobs.ashbyhq.com/api/non-user-graphql`) that returned the full field list
  with required flags for a live Angi job. It is undocumented, so it is used only
  to *prepare*, never relied on — the extension reads the real form anyway.
- **Lever's public postings API has no question list**; questions are only on
  the hosted form. Workday and Oracle expose questions only inside the
  application flow.

### 2.3 What employers now do about automated applications

- Greenhouse **Fraud Detection** evaluates phone, email, location and IP; a
  high-risk signal is "the IP address being linked to a data center".
  [Greenhouse support](https://support.greenhouse.io/hc/en-us/articles/42738009117467-Fraud-Detection)
- Greenhouse **Real Talent** (2026) adds bot and mass-application detection and
  CLEAR identity verification. [Greenhouse](https://www.greenhouse.com/blog/introducing-greenhouse-real-talent),
  [press release](https://www.prnewswire.com/news-releases/greenhouse-real-talent-launches-to-fix-overwhelming-candidate-pipelines-while-combatting-fraud-and-spam-in-hiring-302472057.html)
- Oracle Recruiting can require an **hCaptcha** before applying.
  [Oracle docs](https://docs.oracle.com/en/cloud/saas/talent-management/faimh/enable-hcaptcha.html)
- A Robert Half survey of 2,000+ US hiring managers (reported March 2026): 67%
  said AI-generated applications slowed hiring; employers are adding knockout
  questions and traps. [Hiration summary](https://www.hiration.com/blog/ai-auto-apply-bots/)

### 2.4 What competing products do

| Product | Model | Evidence |
|---|---|---|
| **Simplify Copilot** | Browser extension that autofills "on 100,000+ company career sites in one click" and "saves every application to your Simplify tracker"; Workday, Greenhouse, Lever, iCIMS, Taleo, SmartRecruiters. | [Simplify](https://simplify.jobs/copilot), [Chrome Web Store](https://chromewebstore.google.com/detail/simplify-copilot-autofill/pbanhockgagggenencehbnadejlgchfc) |
| **JobWizard** | Extension; Workday, Greenhouse, Lever, Ashby; AI answers to free-text questions. | [Chrome Web Store](https://chromewebstore.google.com/detail/jobwizard-ai-autofill-for/kbhgdbfkbgkokgkkdhnnlmkhnokjmfib) |
| **Huntr, Careerflow, JobAppFiller** | Extension autofill + tracker; custom questions often paid-tier only. | [comparison test](https://resumeoptimizerpro.com/blog/autofill-job-applications-chrome-extension) |
| **LazyApply, AIApply, JobCopilot** | Automatic mass submission. | LazyApply: 56% of 105 Trustpilot reviews 1-star (March 2026), failed submissions and wrong entries reported, spam-flagging reported. [review roundup](https://www.hiration.com/blog/ai-auto-apply-bots/), [LazyApply review](https://ascendurepro.com/lazyapply-review/) |

The same comparison cites a study in which résumé quality, not autofill, decided
callbacks. The products that last are **extension + human submit + tracker**;
the products with the worst reputations are the ones that submit for you.

### 2.5 Platform and legal constraints

- **Chrome Web Store Limited Use**: an extension may only use data for its
  single disclosed purpose; no selling, no ads, no human reading without
  explicit consent. [policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- **File inputs can be set by script**: the HTML standard declares
  `attribute FileList? files;` (not read-only) on `<input type=file>`, which is
  how extensions attach a résumé via `DataTransfer`.
  [WHATWG](https://html.spec.whatwg.org/multipage/input.html#dom-input-files)
  (MDN's page only documents reading it.) Each adapter must still be tested,
  because some vendors upload on a custom `change` handler.
- **Demographic answers are special-category data** under GDPR Article 9
  (racial/ethnic origin, health, sexual orientation…), which needs *explicit*
  consent. [GDPR Art. 9](https://gdpr-info.eu/art-9-gdpr/)
- **US self-identification forms change**: the OFCCP says its Section 503
  disability self-ID form is discontinued effective 21 September 2026 under a
  rule published 21 August 2026. [DOL](https://www.dol.gov/agencies/ofccp/self-id-forms)
  Demographic questions must therefore be read from the page each time, never
  hard-coded.
- **Server-side browsers exist** (Cloudflare Browser Run: Puppeteer/Playwright on
  Cloudflare's network). [docs](https://developers.cloudflare.com/browser-rendering/)
  They run from data-center IPs — exactly Greenhouse's high-risk signal.

---

## 3. Alternatives considered

Scored 1 (poor) – 5 (good).

| Approach | Reliability | Coverage | Privacy | Security | Maintain | UX | Cost | Verdict |
|---|---|---|---|---|---|---|---|---|
| **A. Official ATS APIs** | 5 | **0** — needs each employer's key | 4 | 4 | 4 | 5 | 3 | Impossible for a job seeker's tool. |
| **B. Server-side headless browser submits** | 2 — CAPTCHAs, DOM drift, fraud flags | 3 | 1 — we would hold Workday passwords | 1 | 2 | 4 | 2 | Rejected: data-center IP is a named fraud signal; holding candidate credentials is unacceptable. |
| **C. Fully automatic mass apply** | 1 | 3 | 2 | 2 | 2 | 2 | 2 | Rejected: evidence of harm to applicants; conflicts with this product's "fewer, better, earlier" purpose. |
| **D. Web app only: copy-paste kit** | 5 | 5 — works anywhere | 5 | 5 | 5 | 2 — slow on Workday | 5 | **Kept** as the baseline and fallback. |
| **E. Bookmarklet** | 2 — blocked by many sites' CSP; cannot persist | 3 | 4 | 3 | 3 | 2 | 4 | Rejected. |
| **F. Desktop app (Electron)** | 3 | 4 | 4 | 3 | 2 | 2 — install friction | 1 | Rejected. |
| **G. Browser extension, human submits** | 4 | 4 — per-vendor adapters | 4 — runs in the user's browser | 4 | 3 | 5 | 3 | **Chosen**, with D as its fallback. |
| **H. Hybrid G + "submit for me" toggle** | — | — | — | — | — | — | — | Rejected: the one click saved is the one moment the person checks what is being sent under their name. |

---

## 4. The recommendation

### 4.1 Architecture

```
 ┌──────────────── Unsaturated web app (Workers + Supabase) ────────────────┐
 │  Applicant profile   Answer library   Résumé versions   Tailoring (exists)│
 │                         │                                                  │
 │                  Application kit  (per job)                                │
 │     résumé version · library answers · drafted answers · approvals        │
 │                         │                    Tracker (statuses, history)   │
 └─────────────────────────┼──────────────────────────────▲──────────────────┘
          short-lived token │  GET kit, signed résumé URL  │ POST events
                            ▼                              │
 ┌──────────────── Browser extension (MV3), user's own browser ─────────────┐
 │  Vendor adapters: Greenhouse · Ashby · Workday · SmartRecruiters · …      │
 │  read form → match to kit → fill → attach résumé → highlight gaps         │
 │  USER CLICKS SUBMIT → detect confirmation → report to tracker             │
 │  Local only: EEO/demographic choices (opt-in), nothing else sensitive     │
 └───────────────────────────────────────────────────────────────────────────┘
```

**Firm decisions**

1. **Nobody but the person submits.** The extension never clicks a submit, next
   or review button on a final step. On Workday it may advance between steps only
   after the person presses a "Fill & continue" button of ours on each step.
2. **Preparation happens in the web app, not in the extension.** The extension is
   a thin executor. Answers are drafted, reviewed and approved where there is
   room to read them, and the same kit powers the no-extension fallback.
3. **The extension talks only to Unsaturated and to the supported vendor hosts.**
   Host permissions are listed per vendor and requested as optional
   permissions; no `<all_urls>`.
4. **Demographic and disability answers never leave the device** and are never
   drafted by AI. Default is to leave them for the person every time; an opt-in
   saves their choice in the extension's local storage only.
5. **We never store ATS passwords.** Workday sign-in is the person's, handled by
   the browser's password manager. We fill the email field only.
6. **The tracker records what actually happened**: opened, prepared, submitted
   (with evidence), and the person's later updates. "Opened" stops being
   "applied" on day one.
7. **Scope stays signed-in only** — the same rule as résumé files.

### 4.2 What gets auto-filled, and what needs approval

| Class | Examples | Source | Filled without asking? |
|---|---|---|---|
| **Identity facts** | name, preferred name, email, phone, city/country, LinkedIn, GitHub, portfolio | Profile | Yes |
| **Documents** | résumé, cover letter | Chosen résumé version | Yes, the version chosen in the kit |
| **Attestations** | work authorisation per country, sponsorship now/future, age 18+, relocation, notice period, start date, criminal record where lawful | Answer library | **Only if approved once in the library AND the job's question matches the library entry exactly** (same country, same meaning). Otherwise approval on this application. |
| **Money** | salary expectation, current salary | Library | **Always approved per application.** Current salary is never stored (illegal to ask in many US states). |
| **Narrative** | "Why us?", "Describe a project…", cover letter text | AI draft from résumé + posting | **Always approved per application**, with evidence lines shown. |
| **Unknown questions** | anything not matched | — | Never filled. Highlighted on the page. |
| **Demographic / disability / veteran** | race, gender, orientation, disability, veteran status | Device only, opt-in | Never by AI; filled only from the person's own saved local choice, and highlighted. |
| **Consents** | GDPR notice, privacy acknowledgement, AI disclosure | — | **Never ticked by us.** The person ticks them. |

"Invent nothing" applies unchanged: a drafted answer may use only facts in the
résumé or the library, and the evidence for each claim is shown next to it — the
same rule the tailoring code already enforces.

---

## 5. The end-to-end experience

### 5.1 One-time setup — "Application profile" (on `/account`)

```
┌ Application profile ─────────────────────────────────────────────── 72% ┐
│ Basics                                                                  │
│  Legal name    [Ada           ] [Lovelace    ]  Preferred [          ]  │
│  Email         [you@…         ]   Phone [+1 555 0100 ]                   │
│  Location      [Toronto, ON, Canada          ]                          │
│  Links         LinkedIn [..........]  GitHub [......]  Site [.......]   │
│                                                                         │
│ Work eligibility                                     ✓ approved 12 Sep  │
│  Canada   Authorised to work  (•) Yes ( ) No   Needs sponsorship ( )Y(•)N│
│  USA      Authorised to work  ( ) Yes (•) No   Needs sponsorship (•)Y( )N│
│  [+ add a country]                                                      │
│                                                                         │
│ Logistics                                                               │
│  Notice period [4 weeks]  Earliest start [date]  Relocate? [Toronto ▾]  │
│  Salary expectation — asked every time, never auto-filled   ⓘ           │
│                                                                         │
│ Diversity questions                                                     │
│  We never store these on our servers and never let AI answer them.      │
│  [ ] Remember my choices on this device only (in the extension)         │
│                                                                         │
│ Résumés                                                                  │
│  ★ Base résumé        resume.pdf        uploaded 6 Sep     [Replace]    │
│    Data engineer      tailored · Stripe  17 Sep            [Open] [×]    │
│                                                                         │
│ Browser extension   ● Connected — Chrome on this laptop   [Disconnect]  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 On a job card — the entry point

```
┌──────────────────────────────────────────────────────────────────────┐
│ Senior Data Engineer                                         new     │
│ Shift Technology · Toronto · 2 days ago                              │
│ data  ·  $140–170k  ·  full time                                     │
│                                                                      │
│ [ View posting ↗ ]   [ Prepare application ]         ○ not applied  │
└──────────────────────────────────────────────────────────────────────┘
```

"View posting" records *opened*, never *applied*.

### 5.3 The application kit — `/apply?job=<key>`

```
┌ Prepare: Senior Data Engineer — Shift Technology (Greenhouse) ────────┐
│                                                                        │
│ 1 Résumé      (•) Base résumé   ( ) Data engineer (tailored)           │
│               [ Tailor for this job → ]   match: 7 of 9 requirements   │
│                                                                        │
│ 2 From your profile                                    all filled ✓    │
│   Name · Email · Phone · LinkedIn                                      │
│                                                                        │
│ 3 This job's questions                          2 need your approval   │
│   ✓ Legally authorised to work in Canada?     Yes      (library)       │
│   ✓ Require visa sponsorship?                  No       (library)       │
│   ! Additional visa/work authorisation details  (required)             │
│     ┌──────────────────────────────────────────────────────────────┐   │
│     │ Canadian citizen; no sponsorship needed now or in future.     │   │
│     └──────────────────────────────────────────────────────────────┘   │
│     drafted from: profile › Canada › authorised           [Approve]    │
│   ! Residing within commuting distance to Toronto?  ( ) Yes ( ) No     │
│     not in your profile — choose once, [x] save to profile             │
│   · GDPR notice — you will tick this yourself on the form              │
│   · Voluntary self-identification — left for you, never stored         │
│                                                                        │
│ ⓘ This employer says: "We use AI to assist in screening…" [opt out ↗] │
│                                                                        │
│ 4 Go                                                                   │
│  [ Open application & fill ↗ ]   needs the extension                   │
│  No extension? [ Copy answers ] [ Download résumé ] [ I submitted it ] │
└────────────────────────────────────────────────────────────────────────┘
```

The "Open application & fill" button is disabled until every *required*
question is either approved or explicitly marked "I'll answer on the page".

### 5.4 On the vendor's page — the extension panel

```
                                     ┌ Unsaturated ─────────────────┐
  [ vendor's own form ]              │ Shift Technology             │
                                     │ Kit ready · 11 of 13 fields  │
  First name   [Ada           ] ✓    │                              │
  Email        [you@…         ] ✓    │ [ Fill this page ]           │
  Resume       resume.pdf       ✓    │                              │
  Commuting?   ( ) Yes ( ) No   ◀──  │ Needs you:                   │
  GDPR notice  [ ]              ◀──  │  • Commuting distance         │
                                     │  • GDPR notice (tick it)      │
                                     │  • Self-ID (optional)         │
                                     │                              │
                                     │ Submit on the page when      │
                                     │ ready. We never submit.      │
                                     └──────────────────────────────┘
```

Filled fields get a thin green edge; fields needing the person get an amber
edge and are listed. Anything the kit and the page disagree on (a question the
kit did not have) is listed, never guessed.

### 5.5 After Submit

```
                                     ┌ Unsaturated ─────────────────┐
  "Thank you for applying to         │ ✓ Application submitted      │
   Shift Technology"                 │ Saved to your tracker        │
                                     │ 17 Sep 14:02 · résumé: Base  │
                                     │ [ View in tracker ]  [Undo]  │
                                     └──────────────────────────────┘
```

If the confirmation cannot be recognised within a minute of leaving the form,
the panel asks: *"Did you submit this application?  [Yes] [Not yet]"*.

### 5.6 The tracker — `/applications`

```
┌ Applications ─────────────────────────────────── 14 this month ───────┐
│ Status ▾ all   Sort ▾ last update                                     │
│                                                                        │
│ ● Submitted   Senior Data Engineer · Shift Technology    17 Sep  ▸    │
│ ● Interview   Platform Engineer · Wealthsimple           12 Sep  ▸    │
│ ○ Prepared    Data Engineer II · Stripe (Workday)        16 Sep  ▸    │
│ ✕ Closed      ML Engineer · Angi     posting closed      10 Sep  ▸    │
│                                                                        │
│ ▸ expanded:                                                            │
│   Submitted 17 Sep 14:02 · confirmed by the Greenhouse thank-you page  │
│   Résumé sent: Base résumé (sha 3f2a…)   Answers sent: 6 [view]        │
│   Status  [Submitted ▾]  Note [recruiter call booked 22 Sep      ]     │
│   ⓘ The posting closed on 19 Sep (from the crawl)                      │
└────────────────────────────────────────────────────────────────────────┘
```

The crawl already knows when a posting closes; the tracker shows it, which no
extension-only competitor can do from job data it does not have.

---

## 6. Walkthroughs

### 6.1 Greenhouse — Shift Technology, Senior Data Engineer (one page)

1. The person clicks **Prepare application** on the card.
2. The server calls
   `boards-api.greenhouse.io/v1/boards/shifttechnology/jobs/7987030003?questions=true`
   (public, no key) and gets the 13 questions listed in §2.2, the EEOC block,
   the GDPR notice and the employer's AI disclaimer.
3. Each question is matched to the library by a normalised fingerprint
   (`work_auth:CA`, `sponsorship:any`, `commute:Toronto`…). Two match approved
   entries; the required free-text "additional visa details" is drafted from the
   profile and shown with its source; "commuting distance" is new and asked once.
4. The person picks the base résumé (or tailors one; the tailored `.docx` is saved
   as a new version), approves the draft, answers the commute question and
   saves it to the profile.
5. **Open application & fill** opens `job-boards.greenhouse.io/shifttechnology/jobs/7987030003`.
   The extension's Greenhouse adapter finds fields by Greenhouse's question IDs
   (the same IDs the public API returned), fills text and selects, and attaches
   the résumé from a 60-second signed URL.
6. The panel lists: GDPR notice (tick it yourself), self-identification
   (optional). The person reads the page and presses **Submit Application**.
7. Greenhouse shows its confirmation; the adapter recognises it and posts
   `submitted` with the URL and timestamp. The tracker stores the résumé version
   and the six answers actually filled.

What can go wrong: the employer embeds the Greenhouse form in an iframe on its
own site → the adapter runs in that frame (content scripts with `all_frames`);
the employer changed a question since preparation → the new question appears as
"needs you", never guessed.

### 6.2 Workday — Dedalus, Senior Database Administrator (multi-step, account)

1. **Prepare application**: Workday exposes no questions in advance, so the kit
   contains the profile, the library, the chosen résumé and the employment and
   education history parsed from the résumé *and confirmed by the person once in
   the profile* (Workday re-asks it field by field).
2. **Open application & fill** opens the posting on
   `dedalus.wd3.myworkdayjobs.com`. The person presses Workday's **Apply** and
   chooses *Apply Manually* (the extension suggests this: Workday's own résumé
   parsing often mis-splits dates and titles, and every mistake must then be
   fixed by hand).
3. **Sign in / Create account** — the person's own step. The extension fills the
   email only. Passwords stay with the browser's password manager. If the tenant
   sends a verification email, the panel says so and waits.
4. Step **My Information** → panel button **Fill this step**: name, address,
   phone, "How did you hear about us" (left for the person — every tenant words
   it differently). The person presses **Save and Continue**.
5. Step **My Experience** → **Fill this step** adds each job and education row
   from the confirmed history, attaches the résumé, fills links. The person
   checks and continues.
6. Step **Application Questions** → questions are read from the page, matched
   to the library; matched-and-approved attestations fill; anything else is
   listed and highlighted. New answers can be saved to the library from the panel
   (with the same approval rules).
7. Steps **Voluntary Disclosures / Self Identify** → never filled by AI. If the
   person opted in on this device, their saved choices fill and are highlighted.
   Terms checkbox: the person's.
8. Step **Review** → the extension does nothing. The person presses **Submit**.
9. Workday shows its submitted state (and lists it under the person's Candidate
   Home); the adapter records `submitted`. If not recognised, the panel asks.

Workday elements are addressed by its `data-automation-id` attributes, not by
layout or text, and every step is its own small state machine that can be
re-run safely if the person goes back.

---

## 7. Data model

All new tables: RLS enabled, **no anon or authenticated policies** (the site
writes with the secret key, as today), `user_id` = the `u:<auth id>` subject
already used, `on delete cascade` from a single `delete my data` path.

```sql
-- One per person. Replaces nothing; user_state keeps name, skills and résumé text.
create table applicant_profile (
  user_id        text primary key,
  preferred_name text,
  email          text,                 -- may differ from the sign-in email
  phone_enc      bytea,                -- encrypted, see §8
  address_enc    bytea,                -- street-level; city/country below are plain
  city           text,
  region         text,
  country        text,                 -- ISO 3166-1 alpha-2
  links          jsonb not null default '{}',   -- {linkedin, github, site}
  notice_period  text,
  earliest_start date,
  relocate_to    text[] not null default '{}',
  updated_at     timestamptz not null default now()
);

-- Reusable answers. One row per meaning, not per wording.
create table answer_library (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  fingerprint   text not null,         -- e.g. 'work_auth:CA', 'sponsorship:US'
  kind          text not null check (kind in ('fact','attestation','preference','narrative')),
  value         jsonb not null,        -- {"choice":"yes"} or {"text":"…"}
  example_label text,                  -- a real question it was approved against
  approved_at   timestamptz,           -- null = draft, never auto-filled
  source        text not null check (source in ('user','ai_draft')),
  updated_at    timestamptz not null default now(),
  unique (user_id, fingerprint)
);

-- Every résumé that was ever offered to an employer.
create table resume_versions (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  label         text not null,
  storage_path  text not null,         -- private bucket, path built from ids only
  sha256        text not null,
  origin        text not null check (origin in ('upload','tailored')),
  job_key       text,                  -- set for tailored versions
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);

create type application_status as enum
  ('prepared','submitted','interviewing','offer','rejected','withdrawn','closed');

create table applications (
  id                uuid primary key default gen_random_uuid(),
  user_id           text not null,
  job_key           text not null,
  provider          text not null,
  status            application_status not null default 'prepared',
  resume_version_id uuid references resume_versions(id),
  submitted_at      timestamptz,
  evidence          jsonb,             -- {how:'confirmation_page'|'user_said', url, text}
  channel           text check (channel in ('extension','kit')),
  note              text,
  updated_at        timestamptz not null default now(),
  unique (user_id, job_key)
);

-- What was actually put in the form. A snapshot: library edits never rewrite history.
create table application_answers (
  application_id uuid not null references applications(id) on delete cascade,
  question       text not null,        -- the label as the employer wrote it
  fingerprint    text,
  answer         jsonb not null,
  origin         text not null check (origin in ('library','ai_draft','typed')),
  approved_at    timestamptz,
  primary key (application_id, question)
);

create table application_events (
  id             bigserial primary key,
  application_id uuid not null references applications(id) on delete cascade,
  at             timestamptz not null default now(),
  type           text not null,        -- prepared, filled, submitted, status_changed, note
  detail         jsonb
);

-- The extension's credentials. Only a hash is stored.
create table extension_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null,
  token_sha256 text not null unique,
  label        text,                   -- "Chrome on MacBook"
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
```

**Not in the database, on purpose:** demographic, disability and veteran
answers; ATS passwords; current salary.

**`job_events` migration:** `applied` is renamed in meaning to `opened`. The
650 existing "applied" rows cannot be told apart from opens, so they become
opens; the tracker starts clean, and the site says so once.

---

## 8. Security and privacy

1. **Encryption at rest for phone and street address**, with AES-GCM via
   WebCrypto in the Worker and a key held as a Worker secret (like
   `SUPABASE_SECRET_KEY`). Everything else in the profile is what the person
   already publishes on a résumé.
2. **Extension authentication**: the person clicks *Connect extension* on
   `/account`; the web app issues a random token shown once to the extension
   (via `chrome.runtime` external messaging limited to our origin). The server
   stores only its SHA-256. Tokens are revocable per device and expire after 90
   days idle. The extension never sees the Supabase keys.
3. **Résumé downloads** use signed URLs valid for 60 seconds, for one path.
4. **Least privilege in the extension**: optional host permissions per vendor
   domain; no `<all_urls>`; no remote code (adapters ship in the package; field
   label dictionaries may be fetched as JSON data only); strict CSP; nothing is
   read from pages outside supported vendors.
5. **No page content leaves the device** except the question labels and
   options needed to match or draft answers — never the person's filled values
   from other sites, never cookies.
6. **AI boundaries**: OpenAI receives the résumé text, the posting and the
   question — as tailoring does today. It never receives demographic questions
   or answers. The existing per-person rate limit applies; drafting is bounded
   to one call per question per application.
7. **Audit**: every fill and every submission writes `application_events`.
8. **Deletion**: one action deletes profile, library, résumé versions (files
   too), applications and tokens; the extension clears its local storage on
   disconnect.
9. **Disclosures**: a Limited Use statement on the site (required by the Chrome
   Web Store), and the employer's own AI disclaimer shown in the kit when the
   vendor publishes one.

---

## 9. Risks and limitations

| Risk | Consequence | Mitigation |
|---|---|---|
| Vendor markup changes | A field stops filling | Per-vendor adapters keyed on stable attributes (Greenhouse question IDs, Workday `data-automation-id`); saved-HTML fixture tests per adapter; a nightly smoke run against one live posting per vendor that only *reads* the form; the panel always lists what was not filled. |
| Wrong legal answer sent | Real harm to the applicant | Attestations fill only from approved entries matched exactly; country-specific fingerprints; per-application approval otherwise; the answers sent are stored and viewable. |
| Employer anti-bot measures | Application flagged | The application is filled in the person's own browser, from their own IP, at human pace, and submitted by them. No server-side traffic touches the form. |
| CAPTCHA (hCaptcha on Oracle, others) | Cannot be filled | The person solves it. Never attempted by us. |
| Workday friction (account per employer, email verification) | Slower than other vendors | Explained in the panel; email pre-filled; password manager recommended. This friction is Workday's, not removable. |
| Chrome Web Store review or policy change | Distribution blocked | Single purpose, Limited Use statement, minimal permissions; the kit fallback keeps the feature working without the extension. |
| No extension on mobile Chrome | Mobile users cannot autofill | The kit (copy, download, "I submitted it") works on any device. |
| Four seats | Tiny audience | Acceptable for building and measuring; the design does not depend on the cap. |
| Undocumented Ashby form endpoint changes | Preparation less complete for Ashby | Only used to pre-draft; the adapter reads the live form regardless. |
| AI drafts overclaim | Credibility | The tailoring evidence rules apply; drafts show their sources; unapproved drafts are never filled. |

Deliberate limitation: **no auto-submit, no bulk apply.** This caps how many
applications a person can send in an hour. That is the intended trade.

---

## 10. Implementation plan

| Phase | Scope | Proves | Size |
|---|---|---|---|
| **0. Truthful tracking** | Card gets *View posting* (records `opened`) and *Mark as applied*; `job_events` meaning fixed; `applications` table with statuses; `/applications` tracker with notes and closed-posting notice. | People use a tracker that is right. | 1 week |
| **1. Profile, library, résumé versions, kit** | `applicant_profile`, `answer_library`, `resume_versions` (tailoring saves its `.docx` as a version); `/apply` kit; Greenhouse questions prefetched; AI drafting with approval; copy buttons; "I submitted it". | The preparation experience, with zero browser automation. | 2–3 weeks |
| **2. Extension MVP: Greenhouse + Ashby** (30.5% of jobs) | MV3 extension (Chrome, then Firefox); connect flow and tokens; panel; fill, attach, highlight; confirmation detection; events to the tracker; fixture tests. | The executor model on single-page forms. | 3–4 weeks |
| **3. Workday** (+41.6% → 72.1%) | Step state machine; experience/education rows; account-step guidance; self-ID handling; Workday fixtures from several tenants. | The hardest vendor. | 3–4 weeks |
| **4. SmartRecruiters, Lever, Oracle, Workable, Rippling** (→ 94.8%) | One adapter each; Oracle hCaptcha guidance; a generic label-matching fallback that fills only exact profile facts on other sites. | Breadth. | 1 week each |
| **5. Refinement** | Status reminders; per-adapter fill-rate reporting (counts only, no content); SmartRecruiters partner enquiry; Safari packaging if there is demand. | Staying good. | ongoing |

**Measures of success**, recorded from the start: share of required fields
filled per vendor, share of submissions recognised automatically, time from
*Open application* to *submitted*, and — the one that matters — interviews per
application, compared before and after.

**Gate between phases:** the fill rate on the phase's vendors is at least 90%
of required non-sensitive fields on fixture and live read-only checks, and no
field was ever filled with a value that was not approved.
