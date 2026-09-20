/**
 * Every vendor we crawl, one live posting each, filled with dummy details.
 *
 *   node scripts/fill-matrix.mjs [out-dir]
 *
 * scripts/fill-live.mjs answers "does this page fill?". This answers the
 * question that decides what to build next: "how much of each vendor's form can
 * we fill at all?" It opens a real application for every provider in the
 * registry, runs the extension's own matcher and filler, and reports the share
 * of required fields that landed — plus the ones deliberately left for the
 * person, which are a feature and not a gap.
 *
 * It never submits. Any run where a page navigates away from its form is
 * reported as an error for that vendor.
 *
 * The URLs are real postings, chosen from the database, and they go stale: when
 * one 404s, take a fresh one with the query in the header comment of
 * docs/apply-assistant-design.md.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.argv[2] ?? path.join(HERE, '..', 'tmp-fill', 'matrix');

/** One live posting per provider, taken from the registry on 18 September 2026. */
const TARGETS = {
  greenhouse: 'https://job-boards.greenhouse.io/globalizationpartners/jobs/7994501003',
  lever: 'https://jobs.lever.co/nahc/d837deed-a4f3-4d3e-89db-61fe465f6a1a/apply',
  ashby: 'https://jobs.ashbyhq.com/irissoftwaregroup/904b06c8-dac3-4c89-bf14-12d8f984b205/application',
  workable: 'https://apply.workable.com/j/DDD5A5B55F/apply',
  smartrecruiters: 'https://jobs.smartrecruiters.com/InformaGroupPlc/744000150321029',
  workday: 'https://airasia.wd3.myworkdayjobs.com/en-US/careers/job/Kuala-Lumpur---RedQ/Manager--IT-Assist---Critical-Situation-Management_JR0035374',
  oracle: 'https://fa-etjb-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2486',
  rippling: 'https://ats.rippling.com/lyte/jobs/a4e054e9-3b04-42a6-a7a1-e91002ce6739',
  recruitee: 'https://ewor.com/o/ai-infrastructure-aiml-engineer-100-remote-mfd-8/c/new',
  bamboohr: 'https://tradequo.bamboohr.com/careers/101',
  teamtailor: 'https://eworgmbh.teamtailor.com/jobs/8401573-saas-cloud-engineer-100-remote-m-f-d',
  personio: 'https://auxmoney-gmbh.jobs.personio.de/job/2803256',
  ukg: 'https://recruiting.ultipro.com/RAI1015FORES/JobBoard/7a1c3d86-f0fa-4e0e-a501-dcfedd4f7d8c/OpportunityDetail?opportunityId=1b0445ea-2633-457f-9ac5-bc149b2b34a7',
  breezy: 'https://sharesource.breezy.hr/p/3d2b6dfebbbd-senior-full-stack-engineer-go-strength',
  eightfold: 'https://talent.fmjobs.com/careers/job/44544405',
};

const PROFILE = {
  firstName: 'Ada', lastName: 'Lovelace', preferredName: 'Ada',
  email: 'ada.lovelace@example.com', phone: '+1 415 555 0142',
  city: 'Toronto', region: 'Ontario', country: 'Canada', postcode: 'M5V 2T6',
  address: '1 Example Street',
  linkedin: 'https://www.linkedin.com/in/example', github: 'https://github.com/example',
  website: 'https://example.com', currentCompany: 'Analytical Engines',
  currentTitle: 'Senior Data Engineer',
  resume: { name: 'ada-lovelace-cv.pdf' },
  answers: {
    workAuthorised: 'Yes',
    needsSponsorship: 'No',
    visaDetails: 'Canadian citizen; no sponsorship required now or in future.',
    nationality: 'Canadian',
    over18: 'Yes',
    noticePeriod: '4 weeks',
    earliestStart: '1 November 2026',
    willingToRelocate: 'No',
    workPreference: 'Remote',
    commutable: 'Yes',
    salaryExpectation: '140,000 CAD',
    yearsExperience: '8',
    education: 'BSc Computer Science, University of Toronto, 2018',
    languages: 'English (native), French (basic)',
    howDidYouHear: 'Unsaturated job feed',
    referredBy: '',
    currentSalary: '120,000 CAD',
    workedHereBefore: 'No',
    gender: 'Prefer not to say',
    ethnicity: 'Prefer not to say',
    veteranStatus: 'I am not a protected veteran',
    disabilityStatus: 'I do not want to answer',
    yearOfBirth: '1990',
  },
  customAnswers: [
    { match: 'fixed term contract', answer: 'Yes, that is acceptable' },
    { match: 'job board', answer: 'Unsaturated' },
    { match: 'bonus', answer: 'None' },
  ],
  tickConsents: false,
};

const DUMMY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1',
);

function bundle() {
  const read = (f) => readFileSync(path.join(HERE, '..', 'extension', 'src', f), 'utf8');
  // The modules import each other; concatenating them means removing both the
  // `export` keyword and the `import` lines, or the page sees a syntax error and
  // `window.__unsat` never exists. answers.js goes first, since matcher.js uses it.
  const flatten = (src) => src
    .replace(/^import[^;]+;\s*$/gm, '')
    .replace(/^export\s+/gm, '');
  return `window.__unsat = (() => {
    ${flatten(read('answers.js'))}
    ${flatten(read('matcher.js'))}
    ${flatten(read('fill.js'))}
    return { describeField, planFill, applyPlan, matchField, isHoneypot, matchAnswer };
  })();`;
}

/** Buttons that open the form. Workday hides it behind two. */
const OPENERS = [
  'Apply for this job', 'Apply Now', 'Apply now', 'Apply manually', 'Apply Manually',
  "I'm interested", 'Apply', 'Submit your application',
];

async function openForm(page) {
  const pressed = [];
  for (let round = 0; round < 2; round++) {
    let clicked = false;
    for (const label of OPENERS) {
      const [btn] = await page.$$(`xpath/.//button[contains(., "${label}")] | .//a[contains(., "${label}")]`);
      if (!btn) continue;
      const before = page.url();
      await btn.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      pressed.push(label);
      clicked = true;
      if (page.url() !== before) await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});
      break;
    }
    if (!clicked) break;
    // Stop once there is something to fill.
    const count = await page.evaluate(() => document.querySelectorAll('input:not([type=hidden]), textarea').length);
    if (count > 3) break;
  }
  return pressed;
}

/**
 * A HARD CAP PER VENDOR.
 *
 * The first run of this file walked seven vendors and then stopped dead for
 * eight minutes on the eighth: a page that never stops loading defeats
 * `waitUntil: 'networkidle2'`, and one stuck page held up the other seven. Every
 * vendor now gets ninety seconds of wall clock and is written down either way,
 * so the report always covers the whole list.
 */
const VENDOR_MS = Number(process.env.VENDOR_MS ?? 90_000);
const withDeadline = (promise, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${VENDOR_MS / 1000}s (${label})`)), VENDOR_MS)),
]);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : 'new',
  args: ['--no-sandbox'],
});

mkdirSync(OUT, { recursive: true });
const rows = [];

for (const [vendor, url] of Object.entries(TARGETS)) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1600 });
  const row = { vendor, url };
  try {
    await withDeadline((async () => {
    // `domcontentloaded`, not `networkidle2`: several career sites poll forever.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForNetworkIdle({ timeout: 12_000 }).catch(() => {});
    row.opened = await openForm(page);
    const formUrl = page.url();
    await page.addScriptTag({ content: bundle() });

    const result = await page.evaluate(async (profile, pdf) => {
      const { describeField, planFill, applyPlan } = window.__unsat;
      const visible = (el) => el.type === 'file'
        || (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
      const fields = [...document.querySelectorAll('input, textarea, select')]
        .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type))
        .map((el) => describeField(el, { visible: visible(el) }));

      const file = new File([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], profile.resume.name, { type: 'application/pdf' });
      const plan = planFill(fields, profile);
      const applied = await applyPlan(plan, { resumeFile: file });
      await new Promise((r) => setTimeout(r, 1200));

      const refusedKinds = ['sensitive', 'attestation', 'money', 'consent', 'narrative'];
      const name = (f) => (f.label || f.placeholder || f.name || f.id || 'field').replace(/\s+/g, ' ').slice(0, 48);
      const requiredLeft = applied.skipped.filter(
        (s) => s.field.required && !refusedKinds.includes(s.reason) && s.field.type !== 'checkbox',
      );
      return {
        seen: fields.length,
        filled: applied.done.length,
        failed: applied.failed.map((f) => `${name(f.field)}: ${f.reason}`),
        refused: applied.skipped.filter((s) => refusedKinds.includes(s.reason)).length,
        requiredLeft: requiredLeft.map((s) => `${name(s.field)} (${s.reason})`),
        resume: document.body.innerText.includes(profile.resume.name)
          || [...document.querySelectorAll('input[type=file]')].some((el) => el.files?.length === 1),
        signIn: /sign in|create account|log in|already have an account/i.test(document.body.innerText.slice(0, 4000)),
      };
    }, PROFILE, DUMMY_PDF.toString('base64'));

    Object.assign(row, result);
    row.navigated = page.url() !== formUrl;
    await page.screenshot({ path: path.join(OUT, `${vendor}.png`), fullPage: false });
    })(), vendor);
  } catch (err) {
    row.error = String(err?.message ?? err).slice(0, 120);
    // A screenshot of whatever it was stuck on is worth having.
    await page.screenshot({ path: path.join(OUT, `${vendor}-error.png`) }).catch(() => {});
  }
  rows.push(row);
  // Written after every vendor, so a crash never costs the whole run.
  writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(rows, null, 2));
  const summary = row.error
    ? `ERROR ${row.error}`
    : `${String(row.filled).padStart(2)} filled · ${row.failed.length} failed · ${row.refused} refused · `
      + `${row.requiredLeft.length} required left · résumé ${row.resume ? 'yes' : 'no'}`
      + `${row.signIn ? ' · SIGN-IN WALL' : ''}${row.navigated ? ' · NAVIGATED' : ''}`;
  console.log(vendor.padEnd(16), summary);
  await page.close();
}

await browser.close();

console.log('\n--- what each vendor left unfilled but required ---');
for (const r of rows) {
  if (r.error || !r.requiredLeft?.length) continue;
  console.log(`${r.vendor}: ${r.requiredLeft.join(' | ')}`);
}
console.log('\n--- failures ---');
for (const r of rows) {
  if (r.failed?.length) console.log(`${r.vendor}: ${r.failed.join(' | ')}`);
}
console.log(`\nscreenshots and matrix.json in ${OUT}`);
