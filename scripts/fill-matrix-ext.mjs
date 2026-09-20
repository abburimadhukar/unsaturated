/**
 * The same matrix, but through the REAL extension.
 *
 *   node scripts/fill-matrix-ext.mjs [url ...]
 *
 * scripts/fill-matrix.mjs injects the modules with `page.addScriptTag`, which a
 * site's Content-Security-Policy may refuse — Ashby did, and the run recorded an
 * error where the extension itself would have worked. This loads extension/ as a
 * real unpacked extension and injects with `chrome.scripting.executeScript`,
 * which is not subject to the page's CSP, so it measures what a person would get.
 *
 * Needs a Chrome that still accepts --load-extension (Chrome for Testing):
 *
 *   npx @puppeteer/browsers install chrome@stable
 *   CHROME_PATH=<that chrome.exe> node scripts/fill-matrix-ext.mjs
 *
 * It never submits.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(HERE, '..', 'tmp-fill', 'matrix-ext');

const DEFAULTS = [
  'https://jobs.ashbyhq.com/irissoftwaregroup/904b06c8-dac3-4c89-bf14-12d8f984b205/application',
  'https://aaff.recruitee.com/o/manager-audit-8/c/new',
  'https://mm-group.eightfold.ai/careers/job/563602813594870',
  'https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/156537',
];
const URLS = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;

const PROFILE = {
  firstName: 'Ada', lastName: 'Lovelace', preferredName: 'Ada',
  email: 'ada.lovelace@example.com', phone: '+1 415 555 0142',
  city: 'Toronto', region: 'Ontario', country: 'Canada', postcode: 'M5V 2T6',
  address: '1 Example Street',
  linkedin: 'https://www.linkedin.com/in/example', github: 'https://github.com/example',
  website: 'https://example.com', currentCompany: 'Analytical Engines',
  currentTitle: 'Senior Data Engineer',
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
    englishLevel: 'C1',
    howDidYouHear: 'Unsaturated job feed',
    referredBy: '',
    currentSalary: '120,000 CAD',
    workedHereBefore: 'No',
    wasReferred: 'No',
    appliedBefore: 'No',
    currentlyEmployed: 'Yes',
    relativeAtCompany: 'No',
    nonCompete: 'No',
    backgroundCheck: 'Yes',
    driversLicense: 'Yes',
    willingToTravel: 'Yes',
    securityClearance: 'None',
    timezone: 'EST (UTC-5)',
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
  experience: [
    { company: 'Analytical Engines', title: 'Senior Data Engineer', location: 'Toronto, ON', start: '2021-03', end: '', current: true },
    { company: 'Difference Works', title: 'Data Engineer', location: 'Toronto, ON', start: '2018-06', end: '2021-02', current: false },
  ],
  education: [
    { school: 'University of Toronto', degree: 'Bachelor of Science', discipline: 'Computer Science', start: '2014-09', end: '2018-05', gpa: '3.7' },
  ],
  skills: ['Python', 'SQL', 'Airflow', 'Spark'],
  resume: {
    name: 'ada-lovelace-cv.pdf',
    dataUrl: 'data:application/pdf;base64,' + Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1',
    ).toString('base64'),
  },
};

const OPENERS = ['Apply for this job', 'Apply Now', 'Apply now', 'Apply manually', 'Apply Manually', "I'm interested", 'Apply'];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : 'new',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 20_000 });
const sw = await swTarget.worker();
// The worker is attached before its script has run; until then `chrome` does
// not exist in it, and the first evaluate fails at random.
for (let i = 0; i < 50 && (await sw.evaluate(() => typeof chrome).catch(() => 'undefined')) !== 'object'; i++) {
  await new Promise((r) => setTimeout(r, 200));
}
await sw.evaluate((p) => chrome.storage.local.set({ profile: p }), PROFILE);
mkdirSync(OUT, { recursive: true });

for (const url of URLS) {
  const host = new URL(url).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1600 });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForNetworkIdle({ timeout: 12_000 }).catch(() => {});

    for (const label of OPENERS) {
      const [btn] = await page.$$(`xpath/.//button[contains(., "${label}")] | .//a[contains(., "${label}")]`);
      if (!btn) continue;
      await btn.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 3500));
      break;
    }

    const permitted = await sw.evaluate((o) => chrome.permissions.contains({ origins: [o] }), `https://${host}/*`);
    const tabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return Math.max(...tabs.map((t) => t.id));
    });
    const injected = await sw.evaluate(async (id) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['src/content.js'] });
        return { ok: true };
      } catch (err) {
        return { error: String(err?.message ?? err).slice(0, 90) };
      }
    }, tabId);

    // Wait for the panel to finish, not a fixed time: Greenhouse's dropdowns
    // take ~12 s to work through, and a 6 s wait recorded "Reading the form…".
    const readPanel = () => page.evaluate(() => {
      const el = document.getElementById('unsaturated-panel');
      return el ? el.shadowRoot.querySelector('.body').innerText : null;
    });
    let panel = null;
    for (let waited = 0; waited < 60_000; waited += 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      panel = await readPanel();
      if (panel && !/^Reading the form/.test(panel)) break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    panel = await readPanel();
    await page.screenshot({ path: path.join(OUT, `${host}.png`) });

    const headline = panel ? panel.split('\n')[0] : (injected.error ?? 'no panel');
    console.log(`${host.padEnd(38)} permitted=${permitted ? 'yes' : 'NO '} ${headline}`);
    if (panel) {
      // Everything the person would still have to do, verbatim from the panel.
      const lines = panel.split('\n');
      let section = '';
      for (const line of lines) {
        if (/^(COULD NOT FILL|NEEDS YOU)$/.test(line.trim())) { section = line.trim(); continue; }
        if (process.env.SHOW_ALL && /^YOUR /.test(line.trim())) { section = 'YOUR'; continue; }
        if (/^(Remember what I typed|I submitted it|YOUR )/.test(line.trim())) { section = ''; continue; }
        if (section && line.trim()) console.log(`    ${section === 'NEEDS YOU' ? 'left ' : section === 'YOUR' ? 'done ' : 'FAIL '} ${line.trim().slice(0, 150)}`);
      }
    }
  } catch (err) {
    console.log(`${host.padEnd(38)} ERROR ${String(err?.message ?? err).slice(0, 90)}`);
  }
  await page.close();
}

await browser.close();
console.log(`\nscreenshots in ${OUT}`);
