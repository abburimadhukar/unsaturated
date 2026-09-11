import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closableBoards, closeScanTargets } from '../src/corpus/db-feed.js';

/**
 * Which postings the close pass is allowed to SEE.
 *
 * The close-scan used to select every open posting and filter them in
 * JavaScript, so all four crawl shards pulled the whole corpus each run to use a
 * quarter of it. Measured 11 Sep 2026 — 110 bytes a row, 67,000 open postings:
 *
 *   one shard reading everything     7.0 MB
 *   four shards, one crawl          28.1 MB
 *   twelve crawls a day              337 MB
 *   thirty days                      9.9 GB   against a 5 GB free allowance
 *
 * Scoping the scan to the boards a shard actually crawled removes three quarters
 * of that. But this is also the code path that once let a healthy Greenhouse
 * board authorise closing every job from the same company's failing Ashby board,
 * so narrowing it is exactly where a mistake costs live postings. Two different
 * failures matter here and they are not symmetrical:
 *
 *   a token MISSING from the scan  → withdrawn jobs stay on the site for ever
 *   a token WRONGLY in the scan    → live jobs get closed
 *
 * The second is unrecoverable without a re-crawl, so the tests below are mostly
 * about it.
 */

const FILTER_CHUNK = 150;

/** Every token the targets will actually ask about, flattened back out. */
const covered = (targets: { provider: string; tokens: string[] }[]) =>
  new Set(targets.flatMap((t) => t.tokens.map((k) => `${t.provider}:${k}`)));

test('every healthy board is asked about exactly once', () => {
  const healthy = ['workday:ppg', 'workday:yai', 'greenhouse:acme', 'ashby:clickhouse'];
  const targets = closeScanTargets(healthy);
  const all = targets.flatMap((t) => t.tokens.map((k) => `${t.provider}:${k}`));
  assert.equal(all.length, 4, 'no board asked about twice');
  assert.deepEqual(new Set(all), new Set(healthy), 'and none dropped');
});

test('NOTHING OUTSIDE THE HEALTHY SET IS EVER ASKED ABOUT', () => {
  // The asymmetry above: a token that sneaks in here has its live jobs closed.
  const healthy = ['workday:ppg', 'greenhouse:acme'];
  const asked = covered(closeScanTargets(healthy));
  for (const id of asked) assert.ok(healthy.includes(id), `${id} was not in the healthy set`);
  assert.equal(asked.size, healthy.length);
});

test('queries are grouped by provider, because tokens are only unique within one', () => {
  // workday:acme and greenhouse:acme are different companies. A statement that
  // filtered board_token alone would reach both.
  const targets = closeScanTargets(['workday:acme', 'greenhouse:acme']);
  assert.equal(targets.length, 2, 'one query per provider, not one for both');
  const providers = targets.map((t) => t.provider).sort();
  assert.deepEqual(providers, ['greenhouse', 'workday']);
  for (const t of targets) assert.deepEqual(t.tokens, ['acme']);
});

test('a shared token is never asked about under the wrong provider', () => {
  const targets = closeScanTargets(['workday:acme', 'greenhouse:acme', 'ashby:acme']);
  for (const t of targets) {
    assert.equal(t.tokens.length, 1);
    // The pairing is what matters: provider and token must travel together.
    assert.ok(['workday', 'greenhouse', 'ashby'].includes(t.provider));
  }
  assert.deepEqual(
    [...covered(targets)].sort(),
    ['ashby:acme', 'greenhouse:acme', 'workday:acme'],
  );
});

test('tokens are chunked, because they travel in the URL', () => {
  const many = Array.from({ length: 370 }, (_, i) => `workday:t${i}`);
  const targets = closeScanTargets(many);
  assert.equal(targets.length, 3, '370 tokens at 150 a time');
  assert.deepEqual(targets.map((t) => t.tokens.length), [150, 150, 70]);
  assert.equal(covered(targets).size, 370, 'and chunking loses nothing');
});

test('a chunk never exceeds the limit, at any size', () => {
  for (const n of [1, 149, 150, 151, 300, 301, 1000]) {
    const targets = closeScanTargets(Array.from({ length: n }, (_, i) => `ashby:t${i}`));
    for (const t of targets) assert.ok(t.tokens.length <= FILTER_CHUNK, `n=${n}`);
    assert.equal(covered(targets).size, n, `n=${n} fully covered`);
  }
});

test('chunking is per provider, not across them', () => {
  // A chunk carries one provider in `.eq('provider', …)`, so mixing providers in
  // one chunk would ask about tokens under the wrong one.
  const ids = [
    ...Array.from({ length: 100 }, (_, i) => `workday:w${i}`),
    ...Array.from({ length: 100 }, (_, i) => `ashby:a${i}`),
  ];
  const targets = closeScanTargets(ids);
  assert.equal(targets.length, 2, 'not one chunk of 150 + one of 50');
  for (const t of targets) {
    const prefix = t.tokens[0]!.startsWith('w') ? 'w' : 'a';
    for (const k of t.tokens) assert.ok(k.startsWith(prefix), 'no provider mixing');
  }
});

test('A TOKEN CONTAINING A COLON IS NOT TRUNCATED', () => {
  // Splitting on every colon would turn `ukg:ACME:123` into token `ACME`, and
  // `ACME` may well be a different employer. Only the first colon separates.
  const targets = closeScanTargets(['ukg:ACME:123']);
  assert.deepEqual(targets, [{ provider: 'ukg', tokens: ['ACME:123'] }]);
});

test('a malformed id is skipped rather than guessed at', () => {
  // No colon, nothing before it, nothing after it. Asking about a half-parsed id
  // risks matching a real board, so it is dropped.
  assert.deepEqual(closeScanTargets(['nocolon', ':leading', 'trailing:']), []);
  // And it does not take valid neighbours down with it.
  const targets = closeScanTargets(['nocolon', 'workday:ppg']);
  assert.deepEqual(targets, [{ provider: 'workday', tokens: ['ppg'] }]);
});

test('no healthy boards means no queries at all', () => {
  assert.deepEqual(closeScanTargets([]), []);
  assert.deepEqual(closeScanTargets(new Set<string>()), []);
});

// ---------------------------------------------------------------------------
// End to end with closableBoards — the scan must inherit its refusals
// ---------------------------------------------------------------------------

const ok = (provider: string, token: string, jobs = 5) => ({ provider, token, jobs });
const failed = (provider: string, token: string) => ({ provider, token, jobs: 0, error: 'refused' });

test('a board that failed this run is never scanned, so it cannot be closed', () => {
  const healthy = closableBoards([ok('workday', 'ppg'), failed('workday', 'yai')]);
  const asked = covered(closeScanTargets(healthy));
  assert.ok(asked.has('workday:ppg'));
  assert.equal(asked.has('workday:yai'), false, 'the failing board is invisible to the scan');
});

test('ONE CAMPUS FAILING KEEPS THE WHOLE TENANT OUT OF THE SCAN', () => {
  // The original bug, now checked through the scoping as well as the filter.
  // Both campuses write board_token `nshe`, so if the successful one were
  // scanned, the refused one's postings would all look withdrawn.
  const healthy = closableBoards([ok('workday', 'nshe', 18), failed('workday', 'nshe')]);
  assert.equal(closeScanTargets(healthy).length, 0, 'nothing to scan, nothing to close');
});

test('a board that answered with zero jobs is not scanned', () => {
  // An empty answer is more often a soft failure than an employer withdrawing
  // every role at once.
  const healthy = closableBoards([ok('greenhouse', 'empty', 0)]);
  assert.deepEqual(closeScanTargets(healthy), []);
});

test('a realistic shard asks far fewer questions than it used to read rows', () => {
  // The point of the change, as arithmetic. 2,500 healthy boards across 12
  // providers is ~21 chunked queries, against 67 pages of 1,000 rows each to
  // read the whole corpus — and each query now returns only its own boards' rows.
  const providers = ['workday', 'greenhouse', 'ashby', 'lever', 'ukg', 'workable',
    'smartrecruiters', 'bamboohr', 'personio', 'recruitee', 'teamtailor', 'rippling'];
  const ids = Array.from({ length: 2500 }, (_, i) => `${providers[i % providers.length]}:t${i}`);
  const targets = closeScanTargets(ids);
  assert.ok(targets.length < 30, `expected well under 30 queries, got ${targets.length}`);
  assert.equal(covered(targets).size, 2500, 'with every board still covered');
});
