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
const HARVESTED = [
  'greenhouse', 'ashby', 'workday', 'smartrecruiters', 'workable', 'personio',
  'bamboohr', 'ukg', 'recruitee', 'teamtailor', 'rippling',
];

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

// ---------------------------------------------------------------------------
// Rippling — wired 9 September 2026
// ---------------------------------------------------------------------------

/**
 * The token is the first path segment of an ats.rippling.com URL.
 *
 * The URLs below are real, taken from CC-MAIN-2026-34 on 9 Sep 2026. That index
 * page holds 9,183 URLs and 937 distinct tokens, against 4 registered.
 */
const ripplingPattern = () => {
  const cc = read('../src/discovery/commoncrawl.ts');
  const block = cc.match(/provider: 'rippling',\s*match: '([^']+)',\s*extract: (\/.*\/[a-z]*),/);
  assert.ok(block, 'the rippling pattern is gone from commoncrawl.ts');
  return { match: block[1]!, extract: new RegExp(block[2]!.slice(1, block[2]!.lastIndexOf('/'))) };
};

test('the rippling pattern pulls the company out of a real board URL', () => {
  const { extract } = ripplingPattern();
  const cases: [string, string][] = [
    ['https://ats.rippling.com/514-careers/jobs/5811104e-78bb-4aaa-a8f6-32bbad47654b', '514-careers'],
    ['https://ats.rippling.com/aaca/jobs/51f21f69-d573-4971-8759-b43d3dd6ce23', 'aaca'],
    ['https://ats.rippling.com/a20-opportunities-page/jobs', 'a20-opportunities-page'],
    ['https://ats.rippling.com/droneshield', 'droneshield'],
    ['https://ats.rippling.com/jobs-at-tuesday-health/jobs', 'jobs-at-tuesday-health'],
  ];
  for (const [url, token] of cases) {
    const m = extract.exec(url);
    assert.ok(m, `no match: ${url}`);
    assert.equal(m[1], token, url);
  }
});

test('the rippling pattern asks the index for the right host', () => {
  assert.equal(ripplingPattern().match, 'ats.rippling.com/*');
});

test('a token that is only routing is refused before it reaches a board', () => {
  // NOT_A_TOKEN exists because the first path segment is not always a company.
  const cc = read('../src/discovery/commoncrawl.ts');
  const m = cc.match(/const NOT_A_TOKEN =\s*(\/[^;]+\/[a-z]*);/);
  assert.ok(m, 'NOT_A_TOKEN is gone');
  const re = new RegExp(m[1]!.slice(1, m[1]!.lastIndexOf('/')), 'i');
  for (const junk of ['jobs', 'api', 'search', 'login']) {
    assert.ok(re.test(junk), `${junk} should never become a board`);
  }
  // And it must not eat real Rippling companies, which are hyphenated slugs.
  for (const real of ['514-careers', 'jobs-at-tuesday-health', 'droneshield', 'atlas-data-storage']) {
    assert.equal(re.test(real), false, `${real} is a real board and must survive`);
  }
});

test('rippling is in the discovery matrix, not just in the code', () => {
  const workflow = read('../.github/workflows/discover.yml');
  const line = workflow.match(/provider: \[([^\]]+)\]/);
  assert.ok(line);
  assert.ok(
    line[1].split(',').map((s) => s.trim()).includes('rippling'),
    'the pattern and the verifier exist but nothing runs the harvest',
  );
});
