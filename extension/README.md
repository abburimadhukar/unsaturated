# Unsaturated autofill — the extension

Fills your own details into an employer's application form. **You always press
the employer's submit button.** Nothing here submits an application, and there
is no code path that clicks a submit, next or review button.

## What it fills

Facts only: first/last/preferred name, email, phone, address, city, region,
postcode, country, location, LinkedIn, GitHub, website, current company, current
title, and your résumé file.

## What it refuses to fill, always

| Kind | Examples | Why |
|---|---|---|
| Sensitive | gender, ethnicity, veteran status, disability, pronouns | Special-category data (GDPR Article 9). Yours to answer, on the day, or not at all. |
| Attestation | work authorisation, sponsorship, right to work, criminal record | A wrong answer is a lie in your name. These come from answers you approve per application — a later phase. |
| Money | salary expectation, desired pay | Always your call. |
| Consent | "I agree…", privacy policy, GDPR notice | You tick your own boxes. |
| Narrative | cover letter, "why do you want to work here?" | Needs your judgement. |
| Traps | a box labelled "Please leave this field blank" | BambooHR ships one. Filling it marks you as a bot. |

Anything it does not recognise is listed in the panel, never guessed at.

## Try it

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
   choose this `extension/` folder.
2. Right-click the extension → **Options** → fill in your details, add a résumé,
   **Save**.
3. Open a job application page and press the extension's toolbar button.
4. Read the panel, finish the questions it left for you, and submit yourself.

**If you loaded version 0.1.0, press Reload on `chrome://extensions` after
pulling.** In that version the toolbar button did nothing at all: it asked
Chrome for the site permission after an `await`, which spends the click's "user
gesture", so Chrome refused with *"This function must be called during a user
gesture"* and the failure was silent.

### What it may read

The manifest lists the job platforms it supports — Greenhouse, Lever, Ashby,
Workable, Recruitee, Rippling, BambooHR, SmartRecruiters, Workday, Oracle,
Teamtailor, Personio, Eightfold — and Chrome grants those at install. On any
other site the button opens a page with an **Allow this site** button, and
nothing is read until you press it.

There is no `content_scripts` block: the extension runs only when you press the
button, never in the background, and never on a page you have not opened.

## Checking it still works

```
npm test -- tests/extension-matcher.test.ts   # against saved copies of 7 real forms
node scripts/fill-live.mjs                    # fills a live Greenhouse form, never submits
node scripts/fill-live.mjs <url> tmp-fill     # any other application page
node scripts/extension-e2e.mjs                # the PACKAGED extension, end to end
node scripts/ats-survey.mjs <dir>             # re-capture how vendors name their fields
```

The end-to-end check loads this folder as a real unpacked extension and drives
the path a click takes: service worker → `chrome.storage.local` → injected
content script → panel. It needs a Chrome that still accepts
`--load-extension`, which everyday Chrome 152 does not:

```
npx @puppeteer/browsers install chrome@stable
CHROME_PATH=<that chrome.exe> node scripts/extension-e2e.mjs
```

**Two things only a person can check**, because no script may answer them: the
permission prompt for a site the manifest does not cover, and any CAPTCHA
(Greenhouse runs reCAPTCHA on its forms, Lever uses hCaptcha, Oracle can require
hCaptcha). Both are fine in normal use — the extension runs in your browser,
where you solve them as you always would.

Measured on live forms, 17 September 2026:

| Vendor | Fields filled | Résumé attached |
|---|---|---|
| Greenhouse | 9 of 9 fillable | yes |
| Lever | 9 of 9 | yes (its own parser rejects the test PDF, which is expected) |
| Workable | 6 of 7 (its own IP-guessed address left alone, flagged) | yes |

## Where the pieces are

- `src/matcher.js` — decides what each box is asking for. Pure, and tested
  against saved copies of seven real forms.
- `src/fill.js` — writes values so a React form believes them, handles the
  dropdowns, attaches the file.
- `src/content.js` — runs on the page, draws the panel.
- `src/background.js` — the toolbar click, and the per-site permission request.
- `src/options.html`, `src/options.js` — your details, kept in this browser only.

Nothing is sent to any server. This build has no account: the profile lives in
the browser's extension storage, and the résumé with it.
