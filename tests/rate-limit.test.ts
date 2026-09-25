import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PER_WINDOW, WINDOW_MS, createLimiter } from '../src/after-apply/rate-limit.js';

/**
 * The ceiling on how fast After applying research can spend money.
 *
 * These lived in tailor-route.test.ts until resume tailoring was removed on
 * 25 Sep 2026. The limiter outlived that feature — After applying research
 * builds one with createLimiter() — so its tests moved with it rather than being
 * deleted along with the route they sat beside.
 *
 * Run with an injected clock: a sliding window has two off-by-one edges and
 * neither can be exercised against a real clock without sleeping for a minute.
 */

test('the allowance runs out at the limit, not one past it', () => {
  // Off by one here is one extra paid OpenAI call per person per window, forever.
  const limiter = createLimiter({ perWindow: 3, windowMs: 1_000 });
  assert.equal(limiter.allow('u', 0), true);
  assert.equal(limiter.allow('u', 10), true);
  assert.equal(limiter.allow('u', 20), true);
  assert.equal(limiter.allow('u', 30), false, 'a fourth attempt was allowed against a limit of 3');
});

test('THE WINDOW SLIDES RATHER THAN RESETTING ON A BOUNDARY', () => {
  // A fixed bucket resetting on the minute lets somebody take the whole allowance
  // at 59 seconds and the whole of the next one at 61 — double the intended rate,
  // at exactly the moment a runaway loop would find it.
  const limiter = createLimiter({ perWindow: 2, windowMs: 1_000 });
  assert.equal(limiter.allow('u', 900), true);
  assert.equal(limiter.allow('u', 950), true);
  assert.equal(limiter.allow('u', 1_010), false, 'a bucket boundary handed out a second allowance');
  assert.equal(limiter.allow('u', 1_060), false);
  // Only once the first attempts have genuinely aged out.
  assert.equal(limiter.allow('u', 1_960), true);
});

test('the allowance comes back after the window', () => {
  const limiter = createLimiter({ perWindow: 1, windowMs: 1_000 });
  assert.equal(limiter.allow('u', 0), true);
  assert.equal(limiter.allow('u', 999), false);
  assert.equal(limiter.allow('u', 1_000), true, 'exactly at the window the oldest attempt has aged out');
});

test('ONE PERSON CANNOT SPEND ANOTHER PERSON ALLOWANCE', () => {
  // Keyed per seat holder. Shared, one busy user would lock everyone else out.
  const limiter = createLimiter({ perWindow: 1, windowMs: 1_000 });
  assert.equal(limiter.allow('alice', 0), true);
  assert.equal(limiter.allow('alice', 1), false);
  assert.equal(limiter.allow('bob', 2), true, "alice's attempts were charged to bob");
});

test('remaining counts down and floors at zero', () => {
  const limiter = createLimiter({ perWindow: 2, windowMs: 1_000 });
  assert.equal(limiter.remaining('u', 0), 2);
  limiter.allow('u', 0);
  assert.equal(limiter.remaining('u', 0), 1);
  limiter.allow('u', 0);
  assert.equal(limiter.remaining('u', 0), 0);
  limiter.allow('u', 0);
  assert.equal(limiter.remaining('u', 0), 0, 'it must never go negative');
});

test('remaining recovers as the window slides', () => {
  const limiter = createLimiter({ perWindow: 2, windowMs: 1_000 });
  limiter.allow('u', 0);
  limiter.allow('u', 500);
  assert.equal(limiter.remaining('u', 600), 0);
  assert.equal(limiter.remaining('u', 1_100), 1, 'the first attempt should have aged out');
});

test('a stream of distinct users does not grow the map without limit', () => {
  // The key is a visitor id and a bug elsewhere could feed this thousands. It
  // must not become a memory leak.
  const limiter = createLimiter({ perWindow: 1, windowMs: 1_000 });
  for (let i = 0; i < 1_000; i++) limiter.allow(`user-${i}`, i);
  assert.equal(limiter.allow('late', 500_000), true);
});

test('the default limits are the documented ones', () => {
  assert.equal(PER_WINDOW, 8);
  assert.equal(WINDOW_MS, 60_000);
});

test('the limiter is honest that it is per isolate', () => {
  // A guard against runaway loops, not a billing guarantee, and the next person
  // to read it must not mistake one for the other. Comment markers stripped
  // before whitespace is flattened, or the phrase reads "NOT a billing * guarantee".
  const src = readFileSync(new URL('../src/after-apply/rate-limit.ts', import.meta.url), 'utf8')
    .replace(/^\s*\*+/gm, ' ')
    .replace(/\s+/g, ' ');
  assert.match(src, /PER ISOLATE, NOT GLOBAL/);
  assert.match(src, /NOT a billing guarantee/);
});

test('After applying research is actually behind a limiter', () => {
  // The point of keeping this file. If the research route stopped limiting,
  // every test above would still pass while nothing was protected.
  const route = readFileSync(new URL('../app/api/after-apply/research/route.ts', import.meta.url), 'utf8');
  assert.match(route, /import \{ createLimiter \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/after-apply\/rate-limit\.js'/);
  assert.match(route, /limiter\(\)\.allow\(visitor\.id\)/);
});
