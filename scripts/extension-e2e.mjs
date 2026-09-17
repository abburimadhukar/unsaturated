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
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, '..', 'extension');

/**
 * THE ONE THING THIS TEST CANNOT DO, AND WHY.
 *
 * In use, the person presses the toolbar button and Chrome shows them a
 * permission prompt for that site; `chrome.permissions.request` needs that
 * gesture and no script may answer the dialog. So the test runs a COPY of the
 * extension whose manifest already holds the host permission for the one page it
 * fills. Everything else is the real thing: the real manifest, the real service
 * worker, the real `chrome.scripting.executeScript`, the real content script and
 * panel, and the profile read back out of `chrome.storage.local`.
 *
 * The permission prompt itself stays a manual check — see extension/README.md.
 */
function extensionCopyWithHostPermission(url) {
  const dir = path.join(os.tmpdir(), `unsat-ext-${Date.now()}`);
  cpSync(SOURCE, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [`${new URL(url).origin}/*`];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}
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

const EXT = extensionCopyWithHostPermission(URL_TO_FILL);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
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
await browser.close();
rmSync(EXT, { recursive: true, force: true });
if (page.url() !== before) process.exit(1);
if (!panel) process.exit(1);
