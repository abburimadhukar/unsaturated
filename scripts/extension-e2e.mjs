/**
 * The packaged extension, end to end, in a real Chrome.
 *
 *   node scripts/extension-e2e.mjs [url]
 *
 * scripts/fill-live.mjs proves the matcher and the filler against a live form,
 * but it injects the modules itself. This loads extension/ as a real unpacked
 * extension and drives the path a person's click takes: the service worker
 * saves a profile, then injects src/content.js into the tab. It therefore also
 * tests the manifest, the module loading and the panel.
 *
 * It never submits. The check at the end fails if the page navigated.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, '..', 'extension');

/**
 * WHAT THIS TEST COVERS, AND THE ONE THING IT CANNOT.
 *
 * Covered: the real manifest, the real service worker, the real
 * `chrome.scripting.executeScript`, the real content script and panel, and the
 * profile read back out of `chrome.storage.local`.
 *
 * Not covered: the permission prompt Chrome shows for a site the manifest does
 * not already cover — no script may answer that dialog. Supported job sites are
 * granted at install (manifest `host_permissions`), so the common path needs no
 * prompt at all; anything else goes through src/allow.html, which is a manual
 * check. See extension/README.md.
 */
const EXT = SOURCE;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TO_FILL = process.argv[2] ?? 'https://job-boards.greenhouse.io/shifttechnology/jobs/7987030003';
const OUT = path.join(HERE, '..', 'tmp-fill');

const PROFILE = {
  firstName: 'Ada', lastName: 'Lovelace', preferredName: 'Ada',
  email: 'ada.lovelace@example.com', phone: '+1 415 555 0142',
  city: 'Toronto', region: 'Ontario', country: 'Canada', postcode: 'M5V 2T6',
  address: '1 Example Street',
  linkedin: 'https://www.linkedin.com/in/example', github: 'https://github.com/example',
  website: 'https://example.com', currentCompany: 'Analytical Engines', currentTitle: 'Senior Data Engineer',
  // A one-line PDF as a data URL, the same shape options.js stores.
  resume: {
    name: 'ada-lovelace-cv.pdf',
    dataUrl: 'data:application/pdf;base64,' + Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
      + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1',
    ).toString('base64'),
  },
};

// HEADFUL=1 opens a window you can watch; HOLD_MS keeps it open afterwards.
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : 'new',
  slowMo: process.env.HEADFUL ? 40 : 0,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
    '--window-size=1400,1000',
  ],
});

// The service worker is the extension's own context: storage and scripting live there.
const worker = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 20_000 });
const sw = await worker.worker();
const extensionId = new URL(worker.url()).host;
console.log('extension loaded:', extensionId);

await sw.evaluate((profile) => chrome.storage.local.set({ profile }), PROFILE);
console.log('profile saved to chrome.storage.local');

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1600 });
await page.goto(URL_TO_FILL, { waitUntil: 'networkidle2', timeout: 60_000 });
const before = page.url();

// Exactly what background.js does when the toolbar button is pressed.
// The tab is found WITHOUT reading any tab's URL: the extension asks for
// `activeTab` and `scripting`, not the `tabs` permission that would let it see
// where every tab is. The newest tab is the one this script just opened.
const tabId = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  return tabs.length ? Math.max(...tabs.map((t) => t.id)) : null;
});
if (tabId === null) throw new Error('could not find the tab from the service worker');

await sw.evaluate(
  (id) => chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['src/content.js'] }),
  tabId,
);

// Let the panel finish its work, then read it the way a person would.
await new Promise((r) => setTimeout(r, 6000));
const panel = await page.evaluate(() => {
  const host = document.getElementById('unsaturated-panel');
  if (!host) return null;
  return host.shadowRoot.querySelector('.body').innerText;
});

mkdirSync(OUT, { recursive: true });
await page.screenshot({ path: path.join(OUT, 'e2e.png'), fullPage: false });

console.log('\n--- panel as the person sees it ---');
console.log(panel ?? 'NO PANEL RENDERED');
console.log('--- end panel ---');

const filledValues = await page.evaluate(() => ({
  first: document.getElementById('first_name')?.value,
  email: document.getElementById('email')?.value,
  phone: document.getElementById('phone')?.value,
  resume: document.body.innerText.includes('ada-lovelace-cv.pdf'),
}));
console.log('page values:', JSON.stringify(filledValues));
console.log('still on the form (nothing submitted):', page.url() === before);

const hold = Number(process.env.HOLD_MS ?? 0);
if (hold > 0) {
  console.log(`
Leaving the window open for ${Math.round(hold / 1000)}s — scroll around; nothing will be submitted.`);
  await new Promise((r) => setTimeout(r, hold));
}
await browser.close();
if (page.url() !== before) process.exit(1);
if (!panel) process.exit(1);
