/**
 * What is STILL EMPTY after the extension runs — on live postings, through the
 * real extension, with a profile in which every detail and every answer is
 * filled. A box left empty here is a gap in the extension, not in the profile.
 *
 *   node scripts/audit-ext.mjs [--persona us|uk] <url | vendor-name> ...
 *
 * Vendor names use the ready-made journeys in fill-vendors-ext's style
 * (oracle's email step, workday's "Apply Manually", ukg's "Sign up"); a URL is
 * opened and its Apply button pressed. Prints the panel, then every visible box
 * that still holds nothing, with its options. Writes a JSON copy and a
 * screenshot to tmp-fill/audit/.
 *
 * Never presses submit, next (except Oracle's email step, with a made-up
 * example.com address), sign in or create account.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PERSONAS, launch, setProfile, press, waitPanel, panelLines, audit, auditLines, journeyFor } from './ext-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'tmp-fill', 'audit');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
let persona = 'us';
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--persona') persona = args[++i];
  else targets.push(args[i]);
}

const { browser, sw } = await launch();
await setProfile(sw, PERSONAS[persona] ?? PERSONAS.us);

for (const url of targets) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1400 });
  const name = new URL(url).host.replace(/[^a-z0-9.]/gi, '_') + '_' + Date.now().toString(36);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForNetworkIdle({ timeout: 12_000 }).catch(() => {});
    await journeyFor(url)(page);
    const pages = await browser.pages();
    const target = pages[pages.length - 1];
    const injected = await press(sw);
    const panel = await waitPanel(target);
    const rows = await audit(target).catch((e) => [{ kind: 'error', label: e.message, value: '', options: [] }]);
    console.log(`\n==== ${url}\n  persona=${persona} inject=${injected} now at ${target.url().slice(0, 100)}`);
    for (const l of panelLines(panel)) console.log(l);
    for (const l of auditLines(rows)) console.log(l);
    writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ url, persona, panel, rows }, null, 2));
    await target.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});
  } catch (err) {
    console.log(`\n==== ${url}\n  ERROR ${String(err?.message ?? err).slice(0, 160)}`);
  }
  await page.close().catch(() => {});
}
await browser.close();
console.log(`\nJSON and screenshots in ${OUT}`);
