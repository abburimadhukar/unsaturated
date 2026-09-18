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
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20_000 });
const sw = await swTarget.worker();
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

    await new Promise((r) => setTimeout(r, 6000));
    const panel = await page.evaluate(() => {
      const el = document.getElementById('unsaturated-panel');
      return el ? el.shadowRoot.querySelector('.body').innerText : null;
    });
    await page.screenshot({ path: path.join(OUT, `${host}.png`) });

    const headline = panel ? panel.split('\n')[0] : (injected.error ?? 'no panel');
    console.log(`${host.padEnd(38)} permitted=${permitted ? 'yes' : 'NO '} ${headline}`);
    if (panel && /left for you/.test(panel)) {
      const needs = panel.split('NEEDS YOU')[1];
      if (needs) console.log(`    left for the person: ${needs.trim().split('\n').slice(0, 4).join(' | ').slice(0, 160)}`);
    }
  } catch (err) {
    console.log(`${host.padEnd(38)} ERROR ${String(err?.message ?? err).slice(0, 90)}`);
  }
  await page.close();
}

await browser.close();
console.log(`\nscreenshots in ${OUT}`);
