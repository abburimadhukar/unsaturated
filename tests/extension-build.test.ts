import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// @ts-ignore — a plain .mjs build script with no types of its own.
import { bundleResumeReader } from '../scripts/build-extension.mjs';
// @ts-ignore — the extension ships plain ES modules.
import { shapeFor } from '../extension/src/fill.js';

/**
 * The extension ships a BUILT copy of the website's résumé reader
 * (extension/src/resume.js), committed so it loads unpacked without npm. A
 * committed build silently goes stale the day someone fixes the reader and
 * forgets to rebuild — so this rebuilds it and compares.
 */
test('extension/src/resume.js is up to date with src/extension/resume-reader.ts', async () => {
  const committed = readFileSync(new URL('../extension/src/resume.js', import.meta.url), 'utf8');
  const fresh = await bundleResumeReader();
  assert.ok(committed === fresh, 'stale: run `node scripts/build-extension.mjs` and commit the result');
});

test('pdf.js and its worker are vendored beside it', () => {
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    assert.ok(existsSync(new URL(`../extension/vendor/${f}`, import.meta.url)), f);
  }
});

test('every file the manifest and pages point at exists', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const paths = [
    manifest.background.service_worker,
    manifest.options_page,
    ...manifest.web_accessible_resources.flatMap((w: { resources: string[] }) => w.resources),
    'src/tracker.html', 'src/tracker.js', 'src/options.js', 'src/content.js', 'src/allow.html', 'src/resume.js',
  ];
  for (const p of paths) assert.ok(existsSync(new URL(`../extension/${p}`, import.meta.url)), p);
});

test('A UNIT IS NEVER STRIPPED OFF A NUMBER — "4 weeks" is not 4', () => {
  const dom = new JSDOM('<input id="n" type="number">');
  const box = dom.window.document.getElementById('n');
  assert.match(String(shapeFor(box, '4 weeks').error), /unit/);
  assert.match(String(shapeFor(box, '120k').error), /unit/);
  assert.match(String(shapeFor(box, '12 LPA').error), /unit/);
  // A currency is not a unit: Breezy's salary box takes this as 140000.
  assert.equal(shapeFor(box, '140,000 CAD').value, '140000');
  assert.equal(shapeFor(box, '6').value, '6');
});
