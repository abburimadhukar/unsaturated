import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getJson, retryAfterMs } from '../src/ats/http.js';
import { AtsFetchError, failureKindFor, type FetchContext } from '../src/ats/types.js';
import { ProviderLimiter } from '../src/corpus/rate-limit.js';
import { harvestCommonCrawl } from '../src/discovery/commoncrawl.js';

/**
 * Never lose a live board to a bug again.
 *
 * On 6 September 2026 the crawler retired 2,263 boards in an afternoon. 2,185
 * of them carried an HTTP 429 against 16 that were genuinely 404, and six
 * sampled afterwards answered 200 with between 3 and 86 live jobs still on
 * them. Two separately reasonable changes did it: a retry-once on 429, which
 * doubled the traffic to the vendor asking us to slow down, and board
 * retirement, which started working the same day.
 *
 * These tests exist so that combination cannot recur.
 */

const ctx = (fetchImpl: unknown): FetchContext =>
  ({ userAgent: 'test', timeoutMs: 5000, fetchImpl }) as FetchContext;

// ---------------------------------------------------------------------------
// A refusal is not a death
// ---------------------------------------------------------------------------

test('only 404 and 410 mean the board is gone', () => {
  assert.equal(failureKindFor(404), 'gone');
  assert.equal(failureKindFor(410), 'gone');
  // Everything else says something about the vendor, not the board.
  for (const s of [429, 500, 502, 503, 504, 403, 401, 408, 418]) {
    assert.equal(failureKindFor(s), 'refused', `HTTP ${s} must not retire a board`);
  }
  // No status at all — a timeout or a dropped socket — is never a death.
  assert.equal(failureKindFor(undefined), 'refused');
});

test('a rate limit is reported as refused, not gone', async () => {
  let calls = 0;
  const c = ctx(async () => {
    calls++;
    return new Response('slow down', { status: 429 });
  });
  await assert.rejects(
    () => getJson('https://x.test/a', 'workable', 't', c),
    (err: AtsFetchError) => {
      assert.equal(err.failure, 'refused');
      assert.equal(err.status, 429);
      return true;
    },
  );
  // THE regression. Retrying doubled traffic to a throttling vendor and took
  // Workable from 42% failing to 90%.
  assert.equal(calls, 1, 'a 429 must cost exactly one request, never two');
});

test('a 404 is reported as gone', async () => {
  const c = ctx(async () => new Response('nope', { status: 404 }));
  await assert.rejects(
    () => getJson('https://x.test/a', 'greenhouse', 't', c),
    (err: AtsFetchError) => err.failure === 'gone',
  );
});

test('a timeout is refused, not gone', async () => {
  const c = ctx(async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  });
  await assert.rejects(
    () => getJson('https://x.test/a', 'workday', 't', c),
    (err: AtsFetchError) => err.failure === 'refused',
  );
});

test('no status at all still cannot retire a board', async () => {
  const c = ctx(async () => { throw new Error('socket hang up'); });
  await assert.rejects(
    () => getJson('https://x.test/a', 'ukg', 't', c),
    (err: AtsFetchError) => err.failure === 'refused',
  );
});

test('retirement counts only boards that are gone', () => {
  const src = readFileSync(new URL('../src/corpus/board-store.ts', import.meta.url), 'utf8');
  // The failing set that advances the counter must be filtered to 'gone'.
  assert.match(src, /const failed = list\.filter\(\(o\) => !o\.ok && o\.failure === 'gone'\)/);
  // And refusals must still be recorded, so a run stays honest about them.
  assert.match(src, /const refused = list\.filter\(\(o\) => !o\.ok && o\.failure !== 'gone'\)/);
  assert.match(src, /spared/);
});

// ---------------------------------------------------------------------------
// When a vendor pushes back, go slower — for that vendor only
// ---------------------------------------------------------------------------

test('a refusal halves concurrency and doubles the gap', () => {
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100, maxGapMs: 4000 });
  l.refused('workable');
  const [w] = l.report();
  assert.equal(w?.provider, 'workable');
  assert.equal(w?.concurrency, 4);
  assert.equal(w?.gapMs, 200);
  l.refused('workable');
  assert.equal(l.report()[0]?.concurrency, 2);
  assert.equal(l.report()[0]?.gapMs, 400);
});

test('backing off never stalls a provider completely', () => {
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100, maxGapMs: 1000 });
  for (let i = 0; i < 40; i++) l.refused('workable');
  const [w] = l.report();
  // A vendor we have given up on entirely would never recover, and its boards
  // would go unread forever rather than slowly.
  assert.ok(w!.concurrency >= 1, 'concurrency must not reach zero');
  assert.ok(w!.gapMs <= 1000, 'the gap must stay capped');
});

test('one vendor refusing never slows another', () => {
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100 });
  for (let i = 0; i < 5; i++) l.refused('workable');
  // Greenhouse never pushed back, so it is absent from the report entirely —
  // the report lists only vendors that changed speed.
  assert.equal(l.report().some((r) => r.provider === 'greenhouse'), false);
});

test('recovery is slow, and only after sustained success', () => {
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100, recoverAfter: 10 });
  l.refused('workable');
  assert.equal(l.report()[0]?.concurrency, 4);

  for (let i = 0; i < 9; i++) l.succeeded('workable');
  assert.equal(l.report()[0]?.concurrency, 4, 'nine clean responses is not enough');

  l.succeeded('workable');
  assert.equal(l.report()[0]?.concurrency, 5, 'the tenth eases it back up by one');
});

test('a stated Retry-After is honoured, and capped', () => {
  assert.equal(retryAfterMs('5'), 5000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('nonsense'), null);
  // A vendor asking for an hour must not park the whole crawl.
  assert.equal(retryAfterMs('99999'), 60_000);
});

test('the limiter actually paces requests', async () => {
  const l = new ProviderLimiter({ startConcurrency: 1, startGapMs: 40 });
  const at: number[] = [];
  for (let i = 0; i < 3; i++) {
    await l.acquire('workable');
    at.push(Date.now());
    l.release('workable');
  }
  assert.ok(at[2]! - at[0]! >= 60, `three requests took only ${at[2]! - at[0]!}ms`);
});

test('the crawl asks the limiter before every board and always releases', () => {
  const src = readFileSync(new URL('../src/corpus/live.ts', import.meta.url), 'utf8');
  assert.match(src, /await limiter\.acquire\(board\.provider\)/);
  // In a finally, or one thrown error leaks a slot and the provider deadlocks.
  assert.match(src, /finally \{\s*limiter\.release\(board\.provider\);/);
  assert.match(src, /limiter\.refused\(board\.provider\)/);
  assert.match(src, /limiter\.succeeded\(board\.provider\)/);
});

// ---------------------------------------------------------------------------
// Discovery must survive a provider it cannot harvest
// ---------------------------------------------------------------------------

test('a provider with no index pattern returns nothing instead of throwing', async () => {
  // Lever has no pattern on purpose: jobs.lever.co/robots.txt blocks Common
  // Crawl's own crawler. Throwing took the whole discovery workflow red on
  // every run, and a failure signal that fires every time is one nobody reads.
  const out = await harvestCommonCrawl({ userAgent: 'test', crawl: 'CC-MAIN-x', provider: 'lever' });
  assert.deepEqual(out.reports, []);
  assert.deepEqual(out.boards, []);
});

test('the CLI says why a patternless provider found nothing', () => {
  const cli = readFileSync(new URL('../src/cli/harvest-cc.ts', import.meta.url), 'utf8');
  assert.match(cli, /has no Common Crawl pattern/);
  assert.match(cli, /that is expected/);
});

test('a refused index page is retried before it is given up on', () => {
  const src = readFileSync(new URL('../src/discovery/commoncrawl.ts', import.meta.url), 'utf8');
  assert.match(src, /attempts = 3/);
  // A 404 means the index holds nothing, which retrying cannot change.
  assert.match(src, /if \(res\.status === 404\) return '';/);
});

test('discovery no longer sends eleven clients at the index at once', () => {
  const wf = readFileSync(new URL('../.github/workflows/discover.yml', import.meta.url), 'utf8');
  const m = /max-parallel:\s*(\d+)/.exec(wf);
  assert.ok(m, 'the matrix must cap its parallelism');
  assert.ok(Number(m[1]) <= 3, `max-parallel is ${m[1]} — the index sheds load well below that`);
});

// ---------------------------------------------------------------------------
// Reviving what was already lost
// ---------------------------------------------------------------------------

test('revive brings back refusals and leaves the genuinely dead alone', () => {
  const src = readFileSync(new URL('../src/cli/boards-revive.ts', import.meta.url), 'utf8');
  const m = /const REFUSAL = (\/.*\/[a-z]*);/.exec(src);
  assert.ok(m, 'expected a REFUSAL pattern');
  const re = new RegExp(m[1]!.slice(1, m[1]!.lastIndexOf('/')), 'i');

  for (const err of [
    'workable/acme: HTTP 429 (429 is rate limiting)',
    'workday/x: HTTP 503',
    'ashby/y: timed out after 20000ms',
    'lever/z: fetch failed',
    'bamboohr/q: HTTP 403 (403 is usually user-agent filtering)',
  ]) {
    assert.ok(re.test(err), `should revive: ${err}`);
  }
  // A 404 really is gone, and must stay retired.
  assert.equal(re.test('greenhouse/trails: HTTP 404 (wrong tenant token)'), false);

  // Reactivating without clearing the counter would retire them again within
  // the hour — that is the loop this breaks.
  assert.match(src, /consecutive_failures: 0/);
  assert.match(src, /active: true/);
});
