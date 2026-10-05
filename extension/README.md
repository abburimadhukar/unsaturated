# Unsaturated autofill — the extension

Reads your résumé once, then fills your details, your work history and your saved
answers into employer application forms. **You always press the employer's
submit button.** Nothing here submits an application, and there is no code path
that clicks a submit, next or review button.

## Start from your résumé

Open **Options** and choose your résumé (PDF or Word). It is read in your browser —
pdf.js is bundled, nothing is uploaded — and every empty box is filled from it and
saved:

| Read from the résumé | |
|---|---|
| You | first / middle / last name, email, phone, city, region, country |
| Links | LinkedIn, GitHub, website — including a "LinkedIn" word whose address is only in the link |
| Work | every job: title, company, location, start, end; current company and title |
| Education | every school: school, degree, discipline, dates, GPA; your highest qualification |
| Skills | the skills section, as a list |
| Worked out | years of experience (jobs added up, overlaps counted once, rounded **down**) and "currently employed" when a job runs to Present — each says how it was worked out |

Boxes filled this way stay **highlighted yellow** until you look at them. A box you
had already filled is never overwritten. What a résumé cannot tell anyone —
sponsorship, notice period, salary — you answer once, below.

## What it fills

**Full details**, for the forms that ask for everything — title (Mr/Ms/Dr…), name
suffix, full date of birth, previous last name, place of birth, marital status,
address line 2 and county. Oracle's forms ask for most of these.

**Your details and history** — everything above, plus address and postcode, into
the matching boxes on the form, including the School / Degree / Discipline / GPA /
Graduation year boxes on Greenhouse's and Workday's newer forms, and your résumé
and (if you saved one) cover-letter **files**.

**Your saved answers** — the questions employers ask over and over. Answer each
once and it is filled everywhere it is asked, however the employer words it:

| | |
|---|---|
| Work eligibility | authorised to work, visa sponsorship, the combined "eligible *without* sponsorship", **work-authorisation / visa status** (F-1 OPT, STEM-OPT, H-1B, Green Card…), **US citizen or permanent resident**, work-authorisation details, nationality, over 18 |
| Logistics | notice period, earliest start, relocation, relocation assistance, preferred location, remote/hybrid, commuting, travel, time zone |
| Money | salary expectation, current salary (blank unless you choose to give it) |
| Experience | years of experience, highest qualification, English level (A1–C2), languages |
| History | worked here before, applied before, currently employed, referred by an employee (yes/no), who referred you, how you heard, may we contact your employer, keep me in mind for other roles |
| Checks | background check, driving licence, security clearance, non-compete, relatives at the company |
| Diversity | gender, pronouns, race/ethnicity, Hispanic/Latino, sexual orientation, transgender, LGBTQ+, veteran, disability, year of birth, communities you belong to — **blank unless you fill them** |

Every answer is matched in all its wordings: a saved "Prefer not to say" is
Greenhouse's "I don't wish to answer", Ashby's "I prefer not to answer" and
Rippling's "Choose not to disclose"; a saved "Bachelor of Science" is a menu's
"Bachelor's Degree".

**Worked out from what you saved.** Some Yes/No questions are not stored but
followed from a fact, the way "eligible without sponsorship" follows from the two
answers above it. "Do you have a Bachelor's degree in Computer Science?" is
answered from your highest qualification; "Do you have at least 5 years of
experience in software development?" from your years. A level you do not hold is a
plain "No". What a total cannot vouch for is left for you, and says why: "3 years
with React?" or a "how many years using React.js" box asks about one tool, not
your career, so the number is yours to put in.

**Your own question/answer pairs**, for what no list can predict — "Do you have
experience with MT4?". A few words from the question, and the answer to give.
Punctuation and word order do not matter — a saved "fixed-term contract" matches
"this is a fixed term contract role" — and a longer, more specific pair always
wins. Manage them (add, edit, **remove**) under *Your own questions* in Options,
or save one on the spot with *Remember what I typed*.

**Job-site accounts.** Workday, UKG and Oracle make you create an account first.
Save one password under *Job-site accounts* in options and it is filled — with
your email — into their "Create account" and "Sign in" pages, including the
"verify password" box. You press *Create Account* / *Sign In* yourself. It is
never shown on the panel, and it goes nowhere but those sites' password boxes.
Use a password you use nowhere else: every company's Workday is a separate
account with the same password.

**Work history and education blocks.** Where a form adds a job or a school with
a button (Breezy's *Add Position* / *Add Education*), the extension presses it
once per job and school on your profile and fills each block — title, company,
school, subject, and the start and end dates. Dates go in the shape each box wants:
a calendar box gets the 1st of the month; a résumé date with only a year is left
for you rather than given a made-up month. SmartRecruiters' and Breezy's blocks
are saved with their own Save button, and what you did in each job goes into the
description box.

**Choices drawn as buttons.** Oracle draws Title and its Yes/No questions as
pills (`<button role="radio">`) with no tick box behind them; those are answered
like any other choice. A ladder of ranges — "1+ years / 3+ years / 5+ years /
7+ years" — takes the highest rung your answer reaches; two overlapping ranges
with your answer on the edge are left for you.

**A label in another language.** A question is read first by its visible words,
then — only if those match nothing — by the field's own name, which vendors keep
in English on a localized form. So Personio's German "Gehaltsvorstellung" and
"Verfügbar ab" are still matched through `field-salary_expectations` and
`field-available_from`. An English form is never affected, because its label is
always tried first.

## On the form

The panel lists what was filled, and keeps what it **worked out** apart from what
it **copied**. A value reasoned to — a Yes/No followed from your other answers
("at least 5 years of experience?"), a country it replaced — appears under
**"Worked out — please check"** with a one-line count, so you know exactly what to
look over before an answer goes out in your name. Below that are your saved
answers and your details, then what failed and **why** — "your answer "Yes"
matches none of the options (S Pass, EP, …)" rather than a shrug — and what it
left for you. Then:

- **Remember what I typed** — answer a question it did not know, press this, and
  the next form that asks gets it filled. A missing detail ("Preferred first name")
  is saved as that detail; a known question as its saved answer; anything else as
  one of your own pairs. Diversity answers are only ever saved from Options.
- **I submitted it** — marks the application as applied in your tracker.
- **My applications** — the tracker: every form it filled, with company, role,
  status (filled → applied → interviewing → offer / rejected / withdrawn), notes,
  and a CSV download.
- **Copy a detail** — every value in your profile, one click from the clipboard,
  for a box no autofill can reach.
- **Following you to the next page** — on Workday, Oracle and other multi-page
  forms, new fields are filled as each page appears (for up to 30 minutes, never
  a box it has already touched, so a box you cleared stays cleared).

Press the toolbar button or **Alt+Shift+F**. Pressing it again on the same page
works (in 0.2.0 the second press silently did nothing).

## What it will not do

| | Why |
|---|---|
| Write a cover letter or "why do you want to work here?" | A generated paragraph is what employers now filter for. A cover letter **you** wrote and saved is pasted into a cover-letter box; nothing else. |
| Tick "I have read and agree…" | A statement made in your name. Off unless you turn on "tick consent boxes" in options. |
| Answer a diversity question you left blank | Voluntary on the form and voluntary here. |
| Turn "4 weeks" into "4" for a number box | A unit changes the meaning; it tells you instead. |
| Invent a birthday for a date box | A year alone is reported, not expanded to 1 January. |
| Fill a trap field | BambooHR ships one labelled "Please leave this field blank"; Workday one labelled "Enter website. This input is for robots only". |
| Press Create Account, Sign In, Next or Save | It fills them; you press them. The only buttons it presses are a form's own "Add Position" / "Add Education". |
| Keep a country the site chose | Oracle opens with Country = the employer's own. A country box holding a country that is not yours is replaced, and the panel names what it replaced. |
| Press submit | Ever. |

## Try it

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → choose this
   `extension/` folder. (Already loaded? Press **Reload** — it should say 0.5.1. Your saved details are kept.)
2. **Options** → choose your résumé → check the yellow boxes → answer the questions
   → **Save**.
3. Open a job application and press the toolbar button (or Alt+Shift+F).
4. Read the panel, finish what it left for you, and submit yourself.

### What it may read

The manifest lists the job platforms it supports — Greenhouse, Lever, Ashby,
Workable, Recruitee, Rippling, BambooHR, SmartRecruiters, Workday, Oracle,
Teamtailor, Personio, Eightfold, Breezy, iCIMS, Jobvite, Taleo, SuccessFactors,
UKG, Dayforce, JazzHR, Pinpoint, Comeet, Homerun, JOIN, ADP, Paylocity, Paycom —
and Chrome grants those at install. On any other site pressing the button grants
that one tab, or opens a page with an **Allow this site** button. There is no
`content_scripts` block: the extension runs only when you press the button.

## Measured, 20 September 2026

Live postings, through the real extension, with a test profile in which every
detail and every answer was filled — so a box left empty is the extension's gap,
not the profile's (`scripts/audit-ext.mjs`):

| Vendor | Filled | Failed | Left for you |
|---|---:|---:|---|
| SmartRecruiters | 24 | 0 | nothing — two jobs and a school added, with dates, and each block saved |
| Rippling | 21 | 0 | two essay questions and its own search box |
| BambooHR | 19 | 0 | references (an essay) |
| Oracle — Ford | 18 | 0 | "how did you hear" (its list has no LinkedIn), two consents, the signature |
| Ashby | 17 | 0 | nothing — gender, orientation, ethnicity, communities, state, both Yes/No buttons |
| JazzHR | 16 | 0 | four bespoke questions and an SMS consent |
| Oracle — Arcadis (UK) | 14 | 0 | the signature |
| Recruitee | 9 | 0 | a salary band with the answer on its edge, left on purpose |
| Eightfold | 9 | 4 | name, email, phone, city, postcode and nationality go in; its Country, Country code, Salutation and work-authorisation menus do not — see below |
| UKG | — | — | its form is behind an account, so there is nothing to fill without creating one |

**Eightfold, then open** (fixed 3 October 2026 — see the next section). Its menus
build their option list only while open, and the press that opens one by hand did
not open it while the form was still settling after "Apply" — so those four were
reported as "the page did not keep the value" and left for the person.

Earlier, on 19 September, with the same harness: Greenhouse 15, Breezy 16,
Workable 14 (2 failed — menus whose options the answer is not), Personio 13,
Teamtailor 6, Lever 6, Workday create-account 3.

## Measured again, 3 October 2026 (live, headless)

The same harness, the same test profile, through 0.5.1:

| Vendor | Filled | Failed | Left for you |
|---|---:|---:|---|
| Rippling | 17 | 0 | one SMS consent (and the CV, already uploaded) |
| Teamtailor | 6 | 0 | the cover letter and a consent |
| Recruitee (a Dutch form) | 4 | 0 | an optional cover letter and an SMS consent |
| Eightfold | 13 | 0 | nothing — Country/Region, Country code, Salutation and work authorisation now fill |

**Eightfold, fixed.** It had been the one open vendor (9 filled, 4 failed). Probed
at the source, three things were wrong, each fixed in `src/fill.js`:

- Its menu builds its list over the network as it opens — a `<ul role="listbox">`
  of 254 options, ~0.5–0.8 s after the press. The open sequence waited a flat
  200 ms, saw it still shut, and fired more presses that closed it again. It now
  **polls** for the menu to open and returns the instant it does, so a slow menu
  gets its time and a fast react-select pays nothing.
- Each option is `<li role="presentation"><button role="option">`, and the option
  selector matched both — so the list came back **doubled** (508 for 254) and the
  press landed on the `<li>`, which Eightfold ignores. Only the innermost node is
  kept now.
- Options read "🇺🇸 (+1) United States of America", so a saved "United States"
  matched none exactly and a loose word match took "United States **Minor Outlying
  Islands**". A leading flag and dial code are **stripped** before matching, so
  the real name wins.

Rippling (17/0), Teamtailor (6/0) and Recruitee (4/0) were re-measured unchanged
after these changes.

**Then again on ten fresh live postings** drawn straight from the crawl database
(one open job per vendor): Greenhouse 19/1, Lever 20/2, BambooHR 18/0, Breezy
18/0, SmartRecruiters 19/0, Recruitee 12/0, Personio (German) 8/0, Workable 6/0,
Ashby 4/0.

Two needed a closer look first. SmartRecruiters' one-click flow sits behind a
DataDome CAPTCHA that blocks a headless browser (its page was a captcha iframe,
no form); in an ordinary window it loads and fills 19/0 — both jobs, the school,
and "I currently work here". The German Personio form reads its labels in German:
"Verfügbar ab" and "Gehaltsvorstellung" matched nothing until the matcher learned
to fall back to a field's own English NAME (`field-available_from`,
`field-salary_expectations`), which vendors keep in English even on a localized
form. It now fills 8/0. English forms are unchanged — the visible label is always
tried first.

**SuccessFactors, newly reached.** An Eightfold posting redirected to its real
application on `career50.sapsf.com`, a host the manifest did not list — so nothing
was filled. Adding `*.sapsf.com` turned that into **17 filled, 2 failed** (account
email and password, name, phone, country code, full address, salary, start date),
the two being a "how did you hear" and a "work permit status" whose lists hold
none of the saved answer. It also showed a date-of-birth box with the placeholder
"mm/dd/yyyy" being read as day-only (a saved 1990-04-12 went in as "12"); a box
whose placeholder is a whole-date shape now takes the whole date.

**Fixed this build.** Recruitee asks "Do you have a Bachelor's degree in X?" and
"at least 5 years of experience in software development?" as Yes/No, and "how many
years … using React.js" as a number. These used to fail with "matches none of the
options" or fill a total that over-claimed one tool; they are now worked out from
your qualification and years, or left for you with the reason why.

## Checking it still works

```
npm test -- tests/extension-matcher.test.ts tests/resume-profile.test.ts tests/extension-build.test.ts
node scripts/build-extension.mjs              # rebuild src/resume.js after changing the résumé reader
node --import tsx scripts/extension-resume-e2e.mjs   # résumé import + a live form, end to end
node scripts/audit-ext.mjs [--persona us|uk] <urls…>   # what is STILL EMPTY after it runs
node scripts/fill-matrix-ext.mjs <urls…>      # live postings through the real extension
node scripts/fill-vendors-ext.mjs [name…]     # Rippling, Teamtailor, Breezy, SmartRecruiters, Oracle, Workday, UKG
```

The end-to-end scripts need a Chrome that still accepts `--load-extension`, which
everyday Chrome 152 does not: `npx @puppeteer/browsers install chrome@stable`, then
`CHROME_PATH=<that chrome.exe>`.

## Where the pieces are

- `src/resume.js` — **generated** from `src/extension/resume-reader.ts` (the
  website's own résumé reader, bundled). `vendor/` is pdf.js. Do not edit either.
- `src/answers.js` — the questions employers ask, their wordings, and the one list
  that drives both the options page and the matching.
- `src/matcher.js` — decides what each box is asking for. Pure, and tested against
  saved copies of real forms.
- `src/fill.js` — writes values so a React form believes them, works the menus,
  attaches files, ticks the right option.
- `src/content.js` — runs on the page: waits for the form, fills, follows to the
  next page, draws the panel, remembers, tracks.
- `src/options.*`, `src/tracker.*` — your profile and your applications.
- `src/background.js`, `src/allow.*` — the toolbar click and per-site permission.

Nothing is sent to any server. This build has no account: your profile, résumé and
applications live in the browser's extension storage. **Download a backup** on the
options page keeps a copy.
