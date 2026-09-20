/**
 * The vendor fixes of 19 September 2026, each on its live form, through the
 * REAL extension in a visible Chrome (SmartRecruiters refuses a headless one).
 *
 *   CHROME_PATH=<Chrome for Testing> node scripts/fill-vendors-ext.mjs [name ...]
 *
 * Each scenario gets to the form the way a person would — Oracle's email step,
 * Workday's "Apply Manually", UKG's "Sign up" — then presses the extension and
 * prints the panel plus the values that matter for that vendor.
 *
 * It NEVER presses Submit, Create Account, Sign In or Continue. The one "Next"
 * it presses is Oracle's email step, which only opens the form, with a made-up
 * example.com address.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const CHROME = process.env.CHROME_PATH ?? path.join(HERE, '..', 'chrome/win64-153.0.8010.47/chrome-win64/chrome.exe');
const OUT = path.join(HERE, '..', 'tmp-fill', 'vendors');
mkdirSync(OUT, { recursive: true });

// An invented person at a public landmark address, so a place search has
// something real to find. The password is a test value, never used anywhere.
const PROFILE = {
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada.lovelace.test@example.com', phone: '+44 20 7946 0958',
  address: '221B Baker Street', city: 'London', region: 'England', postcode: 'NW1 6XE', country: 'United Kingdom',
  linkedin: 'https://www.linkedin.com/in/example', website: 'https://example.com',
  accountPassword: 'Test!Passw0rd-2026',
  answers: {
    workAuthorised: 'Yes', needsSponsorship: 'No', nationality: 'British', salaryExpectation: '60000',
    noticePeriod: '4 weeks', howDidYouHear: 'LinkedIn', gender: 'Prefer not to say', ethnicity: 'Prefer not to say',
    hispanicLatino: 'Prefer not to say', veteranStatus: 'I am not a protected veteran', disabilityStatus: 'Prefer not to say',
  },
  experience: [
    { company: 'Analytical Engines', title: 'Senior Data Engineer', start: '2021-03', end: '', current: true },
    { company: 'Difference Works', title: 'Data Engineer', start: '2018-06', end: '2021-02', current: false },
  ],
  education: [{ school: 'University of London', degree: 'Bachelor of Science', discipline: 'Mathematics', start: '2014-09', end: '2018-05', gpa: '' }],
  resume: {
    name: 'ada-lovelace-cv.pdf',
    dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1').toString('base64'),
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickText(page, texts, { exact = false } = {}) {
  for (const t of texts) {
    const xp = exact
      ? `xpath/.//*[self::a or self::button][normalize-space(.)="${t}"]`
      : `xpath/.//*[self::a or self::button][contains(normalize-space(.), "${t}")]`;
    const [el] = await page.$$(xp);
    if (el) {
      await el.click().catch(() => {});
      return t;
    }
  }
  return null;
}

const SCENARIOS = {
  rippling: {
    url: 'https://ats.rippling.com/lyte/jobs/a4e054e9-3b04-42a6-a7a1-e91002ce6739',
    prepare: async (p) => { await clickText(p, ['Apply now', 'Apply']); await sleep(4000); },
    check: (p) => p.evaluate(() => ['Gender', 'Are you Hispanic/Latino?', 'Veteran Status', 'Disability Status'].map((n) => {
      const lab = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === n);
      const box = lab && document.querySelector(`[aria-labelledby="${lab.id}"]`);
      return `${n} = ${box ? box.textContent.trim() : '(not found)'}`;
    })),
  },
  teamtailor: {
    url: 'https://thejuly.teamtailor.com/jobs/8390898-hr-manager-london-victoria',
    prepare: async (p) => { await clickText(p, ['Apply for this job', 'Apply']); await sleep(3000); },
    check: (p) => p.evaluate(() => [...document.querySelectorAll('input[name^="candidate[location]"], input[name="candidate[phone]"]')]
      .map((i) => `${i.name} = ${i.value}`).filter((x) => !/= $/.test(x))),
  },
  breezy: {
    url: 'https://census.breezy.hr/p/093d20683eb301-qa-engineer/apply',
    prepare: async () => {},
    check: (p) => p.evaluate(() => [...document.querySelectorAll('[ng-model^="candidateSchool."], [ng-model^="candidatePosition."], select[name^=section_]')]
      .map((i) => `${i.getAttribute('ng-model') || i.name} = ${i.tagName === 'SELECT' ? i.selectedOptions[0]?.textContent.trim() : i.value}`)),
  },
  smartrecruiters: {
    url: 'https://jobs.smartrecruiters.com/PAConsulting/744000147973999',
    prepare: async (p) => { await clickText(p, ["I'm interested", 'Apply']); await sleep(9000); },
    check: (p) => p.evaluate(() => {
      const out = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('input, textarea')) if (el.type !== 'file' && el.value) out.push(`${el.id || el.getAttribute('aria-label')} = ${el.type === 'password' ? '••••' : el.value}`);
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot && e.id !== 'unsaturated-panel') walk(e.shadowRoot);
      };
      walk(document);
      return out;
    }),
  },
  oracle: {
    url: 'https://fa-etjb-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2486',
    prepare: async (p) => {
      await sleep(3000);
      await clickText(p, ['Apply Now', 'Apply']);
      await sleep(6000);
      await p.type('input[type=email]', `unsat.probe.${Date.now()}@example.com`).catch(() => {});
      const tick = await p.$('input[type=checkbox]');
      if (tick) await p.evaluate((c) => c.click(), tick);
      await sleep(800);
      await clickText(p, ['Next'], { exact: true });
      await sleep(10000);
    },
    check: (p) => p.evaluate(() => [...document.querySelectorAll('input[id^=country], input[id^=addressLine1], input[id^=city], input[id^=postalCode]')]
      .map((i) => `${i.id} = ${i.value}`)),
  },
  workday: {
    url: 'https://springernature.wd3.myworkdayjobs.com/en-US/SpringerNatureCareers/job/Pune/Senior-Business-Analyst_JR106599',
    prepare: async (p) => {
      await p.waitForFunction(() => /apply/i.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
      await sleep(2000);
      await clickText(p, ['Apply']);
      await sleep(5000);
      await clickText(p, ['Apply Manually']);
      await sleep(6000);
    },
    check: (p) => p.evaluate(() => ['email', 'password', 'verifyPassword', 'beecatcher'].map((id) => {
      const el = document.querySelector(`[data-automation-id="${id}"]`);
      return `${id} = ${!el ? '(not found)' : el.type === 'password' ? (el.value ? `•••• (${el.value.length} chars)` : '(empty)') : el.value || '(empty)'}`;
    })),
  },
  ukg: {
    url: 'https://recruiting2.ultipro.com/PUB1006PUBL/JobBoard/ab2dad24-7911-4792-a444-fc8e7f128834/OpportunityDetail?opportunityId=eb368aa5-76e4-464a-a0a6-f32910f49e23',
    prepare: async (p) => {
      await p.waitForFunction(() => /apply now/i.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
      await sleep(2000);
      // UKG's button is a <ukg-button> custom element, not a link or <button>.
      const [apply] = await p.$$(`xpath/.//ukg-button[contains(translate(normalize-space(.), "APLYNOW", "aplynow"), "apply now")]`);
      await Promise.all([p.waitForNavigation({ timeout: 30000 }).catch(() => {}), apply?.click()]);
      await p.waitForFunction(() => /sign up/i.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
      const [signup] = await p.$$(`xpath/.//a[contains(normalize-space(.), "Sign up")]`);
      await Promise.all([p.waitForNavigation({ timeout: 30000 }).catch(() => {}), signup?.click()]);
      await sleep(4000);
    },
    check: (p) => p.evaluate(() => [...document.querySelectorAll('input')].filter((i) => i.type !== 'hidden')
      .map((i) => `${i.id} = ${i.type === 'password' ? (i.value ? `•••• (${i.value.length} chars)` : '(empty)') : i.value || '(empty)'}`)),
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1300,1400'],
});
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 20_000 });
const sw = await swTarget.worker();
for (let i = 0; i < 50 && (await sw.evaluate(() => typeof chrome).catch(() => 'undefined')) !== 'object'; i++) await sleep(200);
await sw.evaluate((p) => chrome.storage.local.set({ profile: p }), PROFILE);

for (const name of wanted) {
  const sc = SCENARIOS[name];
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });
  try {
    await page.goto(sc.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForNetworkIdle({ timeout: 12_000 }).catch(() => {});
    await sc.prepare(page);
    const pages = await browser.pages();
    const target = pages[pages.length - 1];
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? Math.max(...(await chrome.tabs.query({})).map((t) => t.id)));
    const injected = await sw.evaluate(async (id) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['src/content.js'] });
        return 'ok';
      } catch (err) {
        return String(err?.message ?? err).slice(0, 120);
      }
    }, tabId);
    let panel = null;
    for (let w = 0; w < 90; w++) {
      await sleep(1000);
      panel = await target.evaluate(() => document.getElementById('unsaturated-panel')?.shadowRoot.querySelector('.body').innerText ?? null).catch(() => null);
      if (panel && !/^Reading the form/.test(panel)) break;
    }
    await sleep(Number(process.env.EXTRA_WAIT || 1500));
    panel = await target.evaluate(() => document.getElementById('unsaturated-panel')?.shadowRoot.querySelector('.body').innerText ?? null).catch(() => null);
    console.log(`\n==== ${name}  (${injected})  ${target.url().slice(0, 90)}`);
    if (panel) {
      let section = '';
      for (const line of panel.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (/^(YOUR SAVED ANSWERS|YOUR DETAILS|COULD NOT FILL|NEEDS YOU)/.test(line)) { section = line.split(' —')[0]; console.log(`  ${section}`); continue; }
        if (/^(Remember what I typed|I submitted it|My applications|Copy a detail|Following you|Check every answer)/.test(line)) { section = ''; continue; }
        if (/filled ·/.test(line) || section) console.log(`    ${line.slice(0, 150)}`);
      }
    } else console.log('  NO PANEL');
    console.log('  on the page:');
    for (const v of await sc.check(target).catch((e) => [`check failed: ${e.message}`])) console.log(`    ${v}`);
    await target.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});
  } catch (err) {
    console.log(`\n==== ${name}  ERROR ${String(err?.message ?? err).slice(0, 120)}`);
  }
  await page.close().catch(() => {});
}
await browser.close();
console.log(`\nscreenshots in ${OUT}`);
