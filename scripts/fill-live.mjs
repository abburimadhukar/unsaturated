/**
 * Fills a real application form with dummy details, and never submits it.
 *
 *   node scripts/fill-live.mjs [url]
 *
 * The fixtures in tests/fixtures/forms are frozen copies, so they cannot notice
 * a vendor redesign. This does: it drives the person's own Chrome, runs the same
 * two modules the extension ships (extension/src/matcher.js and fill.js), and
 * reports what landed in the page. It stops at the submit button, always — there
 * is no code path here that clicks it, and the check at the end fails if the
 * page navigated away from the form.
 *
 * The details are obviously fake (Ada Lovelace, example.com) so that an
 * accidental submission would be recognisable and retractable. The résumé is a
 * generated one-line PDF.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TO_FILL = process.argv[2] ?? 'https://job-boards.greenhouse.io/shifttechnology/jobs/7987030003';
const OUT = process.argv[3] ?? path.join(HERE, '..', 'tmp-fill');

const PROFILE = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  preferredName: 'Ada',
  email: 'ada.lovelace@example.com',
  phone: '+1 415 555 0142',
  city: 'Toronto',
  region: 'Ontario',
  country: 'Canada',
  postcode: 'M5V 2T6',
  address: '1 Example Street',
  linkedin: 'https://www.linkedin.com/in/example',
  github: 'https://github.com/example',
  website: 'https://example.com',
  currentCompany: 'Analytical Engines',
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

/** A real, minimal PDF, so the vendor's own file validation is exercised. */
const DUMMY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 60>>stream\nBT /F1 12 Tf 20 50 Td (Ada Lovelace - test resume) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/** The extension's modules, turned into one script a page can run as-is. */
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1600 });
await page.goto(URL_TO_FILL, { waitUntil: 'networkidle2', timeout: 60_000 });

// Some vendors only render the form after an "Apply" click.
for (const label of ['Apply for this job', 'Apply now', 'Apply', "I'm interested"]) {
  const [btn] = await page.$$(`xpath/.//button[contains(., "${label}")] | .//a[contains(., "${label}")]`);
  if (btn) {
    await btn.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    break;
  }
}

const urlBeforeFill = page.url();
await page.addScriptTag({ content: bundle() });
// SHOW_ALL=1 lists every field left alone, not just the notable ones.
if (process.env.SHOW_ALL) await page.evaluate(() => { window.__showAll = true; });

const result = await page.evaluate(
  async (profile, pdfBase64) => {
    const { describeField, planFill, applyPlan } = window.__unsat;
    const isVisible = (el) => el.type === 'file' || (el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none');

    const fields = [...document.querySelectorAll('input, textarea, select')]
      .filter((el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type))
      .map((el) => describeField(el, { visible: isVisible(el) }));

    const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
    const file = new File([bytes], profile.resume.name, { type: 'application/pdf' });

    const plan = planFill(fields, profile);
    const applied = await applyPlan(plan, { resumeFile: file });
    // The résumé upload is asynchronous on some vendors: Greenhouse shows the
    // filename a beat after the change event. Give it that beat before judging.
    await new Promise((r) => setTimeout(r, 1500));

    const name = (f) => (f.label || f.placeholder || f.name || f.id || 'field').replace(/\s+/g, ' ').slice(0, 60);
    return {
      fieldsSeen: fields.length,
      // `committed` is what a combobox settled on; its input goes back to empty.
      done: applied.done.map((d) => ({
        key: d.key, field: name(d.field), why: d.why,
        readBack: d.committed || d.field.el.value,
      })),
      failed: applied.failed.map((d) => ({ key: d.key, field: name(d.field), reason: d.reason })),
      refused: applied.skipped
        .filter((s) => window.__showAll || s.field.required
          || ['sensitive', 'attestation', 'money', 'consent', 'narrative'].includes(s.reason))
        .map((s) => ({ field: name(s.field), reason: s.reason, type: s.field.type })),
      // Read from the page, not from our own reference: Greenhouse swaps the
      // input element out once it has accepted the file.
      resumeAttached: document.body.innerText.includes(profile.resume.name),
    };
  },
  PROFILE,
  DUMMY_PDF.toString('base64'),
);

mkdirSync(OUT, { recursive: true });
const shot = path.join(OUT, 'filled.png');
await page.screenshot({ path: shot, fullPage: true });
writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));

console.log(`\n${URL_TO_FILL}`);
console.log(`fields on the page: ${result.fieldsSeen}`);
console.log(`\nFILLED (${result.done.length}):`);
for (const d of result.done) console.log(`  ${d.field.padEnd(42)} ${String(d.readBack).slice(0, 34).padEnd(36)} ${d.why}`);
if (result.failed.length) {
  console.log(`\nFAILED (${result.failed.length}):`);
  for (const d of result.failed) console.log(`  ${d.field.padEnd(42)} ${d.reason}`);
}
console.log(`\nLEFT FOR THE PERSON (${result.refused.length}):`);
for (const r of result.refused) console.log(`  ${r.field.padEnd(42)} ${(r.type || '').padEnd(9)} ${r.reason}`);
console.log(`\nrésumé attached: ${result.resumeAttached}`);
console.log(`screenshot: ${shot}`);

// The one assertion that matters: nothing was submitted.
const urlAfter = page.url();
const stillOnForm = urlAfter === urlBeforeFill;
console.log(`still on the form (nothing submitted): ${stillOnForm}`);
await browser.close();
if (!stillOnForm) {
  console.error('THE PAGE NAVIGATED — that must never happen in this script');
  process.exit(1);
}
