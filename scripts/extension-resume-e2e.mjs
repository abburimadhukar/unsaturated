/**
 * "Start from your résumé", end to end, in a real Chrome with the real extension.
 *
 *   CHROME_PATH=<Chrome for Testing> node --import tsx scripts/extension-resume-e2e.mjs [job-url]
 *
 * 1. Makes a résumé for an invented person twice over — a PDF printed by Chrome
 *    (with its LinkedIn address hidden behind a link, as real ones often are)
 *    and a .docx from the website's own writer.
 * 2. Uploads each on the extension's options page and prints what was read.
 * 3. Opens a live application form, presses the extension TWICE (the second
 *    press used to crash), and prints the panel.
 * 4. Types an answer into a question the extension could not fill, presses
 *    "Remember what I typed", and checks the answer was saved.
 * 5. Checks the application landed in the tracker.
 *
 * It never submits.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { docxBytes } from '../src/ui/docx.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const OUT = path.join(HERE, '..', 'tmp-fill', 'resume-e2e');
const CHROME = process.env.CHROME_PATH ?? path.join(HERE, '..', 'chrome/win64-153.0.8010.47/chrome-win64/chrome.exe');
const JOB = process.argv[2] ?? 'https://job-boards.greenhouse.io/globalizationpartners/jobs/7994501003';
mkdirSync(OUT, { recursive: true });

const RESUME_TEXT = `JORDAN A. EXAMPLE
Toronto, ON | +1 (416) 555-0199 | jordan.example@example.com | LinkedIn | github.com/jexample

SUMMARY
Data engineer with a habit of making pipelines boring.

EXPERIENCE
Northwind Analytics Inc.    Mar 2021 – Present
Senior Data Engineer
• Built the ingestion platform that replaced six cron jobs.
• Cut warehouse spend by 30%.

Contoso Retail, Toronto, ON    Jun 2017 – Feb 2021
Data Engineer
• Owned the nightly sales feed.

EDUCATION
University of Waterloo    Sep 2012 – Apr 2017
Bachelor of Applied Science in Computer Engineering, GPA: 3.7/4.0

SKILLS
Languages: Python, SQL, Scala
Tools: Airflow, dbt, Spark, Kafka
`;

const html = `<!doctype html><meta charset="utf-8"><body style="font:11pt Arial;margin:40px">
${RESUME_TEXT.split('\n').map((l) => {
  if (!l.trim()) return '<div style="height:10px"></div>';
  const linked = l.replace('LinkedIn', '<a href="https://www.linkedin.com/in/jordan-example">LinkedIn</a>');
  if (/^[A-Z .]+$/.test(l.trim()) && l.trim().length < 30) return `<h3 style="margin:8px 0 2px">${l}</h3>`;
  const dates = /^(.*?)\s{3,}(.*)$/.exec(linked);
  if (dates) return `<div style="display:flex;justify-content:space-between"><b>${dates[1]}</b><span>${dates[2]}</span></div>`;
  return `<div>${linked}</div>`;
}).join('\n')}</body>`;

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
const extId = new URL(swTarget.url()).host;

// ---- the two résumés -------------------------------------------------------
const printer = await browser.newPage();
await printer.setContent(html);
const pdfPath = path.join(OUT, 'jordan-example.pdf');
writeFileSync(pdfPath, await printer.pdf({ format: 'A4' }));
await printer.close();
const docxPath = path.join(OUT, 'jordan-example.docx');
writeFileSync(docxPath, await docxBytes(RESUME_TEXT.replace('LinkedIn', 'linkedin.com/in/jordan-example')));

async function importResume(file) {
  await sw.evaluate(() => chrome.storage.local.clear());
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 2400 });
  page.on('pageerror', (e) => console.log('   page error:', e.message));
  await page.goto(`chrome-extension://${extId}/src/options.html`);
  const input = await page.$('#resume');
  await input.uploadFile(file);
  await page.waitForFunction(() => /Read from your résumé|could not be read|Nothing new/.test(document.getElementById('readStatus').innerText), { timeout: 30_000 });
  const status = await page.$eval('#readStatus', (el) => el.innerText);
  const yellow = await page.$$eval('.from-resume', (els) => els.length);
  await page.screenshot({ path: `${file}.options.png` }).catch((e) => console.log("   screenshot failed:", e.message));
  const { profile } = await sw.evaluate(() => chrome.storage.local.get('profile'));
  await page.close();
  return { status, yellow, profile };
}

for (const file of (process.env.ONLY === "docx" ? [docxPath] : [pdfPath, docxPath])) {
  const { status, yellow, profile } = await importResume(file);
  console.log(`\n=== ${path.basename(file)} ===`);
  console.log(status.split('\n').map((l) => `   ${l}`).join('\n'));
  console.log(`   highlighted boxes: ${yellow}`);
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]).filter(([, v]) => v));
  console.log('   details:', JSON.stringify(pick(profile, ['firstName', 'middleName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'website', 'city', 'region', 'country', 'currentCompany', 'currentTitle'])));
  console.log('   answers:', JSON.stringify(profile.answers));
  console.log('   jobs   :', JSON.stringify(profile.experience));
  console.log('   schools:', JSON.stringify(profile.education));
  console.log('   skills :', (profile.skills || []).join(', '));
  console.log('   résumé stored:', profile.resume?.name, `${Math.round((profile.resume?.dataUrl?.length ?? 0) / 1024)} KB`);
}

// ---- fill a live form, twice ------------------------------------------------
// The questions a résumé cannot answer, as the person would type them in.
await sw.evaluate(async () => {
  const { profile } = await chrome.storage.local.get('profile');
  profile.answers = { ...profile.answers, workAuthorised: 'Yes', needsSponsorship: 'No', noticePeriod: '4 weeks', salaryExpectation: '140,000 CAD', howDidYouHear: 'Unsaturated job feed', workedHereBefore: 'No', gender: 'Prefer not to say', ethnicity: 'Prefer not to say' };
  await chrome.storage.local.set({ profile });
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1800 });
await page.goto(JOB, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForNetworkIdle({ timeout: 12_000 }).catch(() => {});
const startUrl = page.url();
const tabId = await sw.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id)));
const inject = () => sw.evaluate(async (id) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['src/content.js'] });
    return 'ok';
  } catch (err) {
    return String(err?.message ?? err);
  }
}, tabId);
const panelText = () => page.evaluate(() => document.getElementById('unsaturated-panel')?.shadowRoot.querySelector('.body').innerText ?? null);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log(`\n=== ${JOB} ===`);
console.log('   first press :', await inject());
const t0 = Date.now();
let first = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  first = await panelText();
  if (first && !/^Reading the form/.test(first)) break;
}
console.log(`   panel finished after ${Math.round((Date.now() - t0) / 1000)} s`);
console.log(first ? first.split('\n').slice(0, 40).map((l) => `   | ${l}`).join('\n') : '   NO PANEL');
console.log('   second press:', await inject());
await new Promise((r) => setTimeout(r, 12_000));
const second = await panelText();
console.log('   after second press:', second ? second.split('\n')[0] : 'NO PANEL');
const declared = errors.filter((e) => /already been declared/.test(e));
console.log(`   "already declared" errors: ${declared.length}`);
await page.screenshot({ path: path.join(OUT, 'form.png'), fullPage: true });

// ---- remember what I typed ---------------------------------------------------
const typed = await page.evaluate(() => {
  // The first empty, visible, plain text box the panel listed as needing you.
  const boxes = [...document.querySelectorAll('input[type=text], input:not([type]), textarea')]
    .filter((el) => !el.value && el.getClientRects().length && !el.getAttribute('role') && !el.closest('#unsaturated-panel'));
  const target = boxes.find((el) => (el.labels?.[0]?.textContent || '').trim().length > 3);
  if (!target) return null;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value').set;
  setter.call(target, 'An answer I typed myself');
  target.dispatchEvent(new Event('input', { bubbles: true }));
  return target.labels[0].textContent.trim().slice(0, 80);
});
console.log(`\n   typed into: ${typed ?? '(no free-text question left on this form)'}`);
const clicked = await page.evaluate(() => {
  const b = document.getElementById('unsaturated-panel')?.shadowRoot.querySelector('[data-act="remember"]');
  if (!b) return false;
  b.click();
  return true;
});
await new Promise((r) => setTimeout(r, 1500));
const msg = await page.evaluate(() => document.getElementById('unsaturated-panel')?.shadowRoot.querySelector('.msg')?.textContent);
const { profile: after } = await sw.evaluate(() => chrome.storage.local.get('profile'));
console.log(`   remember clicked: ${clicked} → "${msg}"`);
console.log('   saved pairs now:', JSON.stringify(after.customAnswers));

// ---- tracker ----------------------------------------------------------------
const { applications } = await sw.evaluate(() => chrome.storage.local.get('applications'));
console.log('\n   tracker rows:', JSON.stringify((applications || []).map((a) => ({ company: a.company, title: a.title, status: a.status, filled: a.filled }))));
const tracker = await browser.newPage();
await tracker.goto(`chrome-extension://${extId}/src/tracker.html`);
await new Promise((r) => setTimeout(r, 800));
await tracker.screenshot({ path: path.join(OUT, 'tracker.png') });

console.log(`\n   page navigated (a submit would): ${page.url() !== startUrl ? 'YES — CHECK' : 'no'}`);
console.log(`   screenshots in ${OUT}`);
await browser.close();
