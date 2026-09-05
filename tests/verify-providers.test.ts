import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Every provider the crawler can read must also be verifiable.
 *
 * `endpoint()` returning null makes a board "unknown", and only `live` boards
 * are ever stored — so a provider missing from that switch harvests thousands
 * of candidates, verifies every one as unclear, stores nothing, and reports
 * success. A discovery run found 1,667 new Personio boards and silently dropped
 * all of them exactly that way.
 *
 * This is a source-level check on purpose: the real thing needs network access
 * and would make the suite depend on other people's servers being up.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const verify = read('../src/discovery/verify.ts');
const adapters = read('../src/ats/adapters/index.ts');

/** Providers the discovery harvest can actually produce candidates for. */
const HARVESTED = ['greenhouse', 'ashby', 'workday', 'smartrecruiters', 'workable', 'personio'];

test('every harvested provider has a verification endpoint', () => {
  const missing = HARVESTED.filter((p) => !verify.includes(`case '${p}':`));
  assert.deepEqual(missing, [],
    `these can be discovered but never verified, so nothing they find is ever stored: ${missing.join(', ')}`);
});

test('every provider named in the discovery workflow can be verified', () => {
  const workflow = read('../.github/workflows/discover.yml');
  const line = workflow.match(/provider: \[([^\]]+)\]/);
  assert.ok(line, 'the discovery matrix is gone');
  const providers = line[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(providers.length >= 4, `matrix looks wrong: ${providers.join(', ')}`);
  const unverifiable = providers.filter((p) => !verify.includes(`case '${p}':`));
  assert.deepEqual(unverifiable, [],
    `the workflow runs discovery for providers nothing can verify: ${unverifiable.join(', ')}`);
});

test('every Common Crawl pattern maps to a verifiable provider', () => {
  const cc = read('../src/discovery/commoncrawl.ts');
  const providers = [...cc.matchAll(/provider: '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(providers.length >= 6, `expected several patterns, found ${providers.length}`);
  const unverifiable = [...new Set(providers)].filter((p) => !verify.includes(`case '${p}':`));
  assert.deepEqual(unverifiable, [],
    `harvested from the index but unverifiable, so silently discarded: ${unverifiable.join(', ')}`);
});

test('personio is read as XML, not JSON', () => {
  // Its feed is XML. Parsing it as JSON returns null, which makes a live board
  // look empty — a quieter failure than an error, and harder to notice.
  assert.match(verify, /provider === 'personio'\s*\?\s*await res\.text\(\)/);
  assert.match(verify, /<position\[\\s>\]/, 'the XML job counter is missing or malformed');
});

test('a provider with no adapter is not in the discovery matrix', () => {
  // Discovering boards the crawler cannot read would fill the registry with
  // rows that fail every crawl forever.
  const workflow = read('../.github/workflows/discover.yml');
  const line = workflow.match(/provider: \[([^\]]+)\]/)![1];
  for (const p of line.split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.ok(adapters.includes(p), `${p} is discovered but has no adapter to crawl it`);
  }
});
