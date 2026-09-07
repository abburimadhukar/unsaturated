import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { backfillDescriptions, fetchDetail, needsBackfill } from '../src/ats/describe.js';
import { getJson } from '../src/ats/http.js';
import { interleaveByProvider } from '../src/corpus/live.js';
import { summariseVerification, type VerifyResult } from '../src/discovery/verify.js';
import type { BoardRef, FetchContext, NormalizedJob } from '../src/ats/types.js';

/**
 * Four faults found by auditing a completed crawl against the live database and
 * the live site.
 *
 * None of them were visible to the existing tests, because none of them appear
 * at small sizes: a chunk of 500 keys is only too long once keys are 51
 * characters, a vendor is only overwhelmed once it holds thousands of boards,
 * and a provider only looks fresh-and-empty once it has been crawled from a
 * board discovered today. So these reproduce the SCALE, not just the shape.
 */

// ---------------------------------------------------------------------------
// 1. Closing withdrawn jobs — the URL length ceiling
// ---------------------------------------------------------------------------

test('the close pass cannot build a URL PostgREST will reject', () => {
  // `.in('key', chunk)` travels in the query string, and the request line has a
  // hard 16 KB limit. At 500 keys the close pass built ~29 KB and every chunk
  // came back 400 Bad Request — four times per crawl, every hour. Because the
  // stale list is ordered by key, the SAME leading 500 failed forever; only the
  // short final chunk ever got through.
  const src = readFileSync(new URL('../src/corpus/db-feed.ts', import.meta.url), 'utf8');
  const declared = /const FILTER_CHUNK = (\d+);/.exec(src);
  assert.ok(declared, 'db-feed.ts must declare FILTER_CHUNK');
  const chunk = Number(declared[1]);

  const LONGEST_KEY = 69; // the longest key measured in the corpus
  const URL_LIMIT = 16_384; // PostgREST/nginx request-line ceiling
  const worstCase = chunk * LONGEST_KEY * 1.2; // percent-encoding inflates it
  assert.ok(
    worstCase < URL_LIMIT,
    `${chunk} keys of ${LONGEST_KEY} chars is ~${Math.round(worstCase)} bytes, over ${URL_LIMIT}`,
  );

  // And the close pass must actually use it, not the body-sized CHUNK.
  const closeBlock = src.slice(src.indexOf('const stale ='), src.indexOf('Reclaim rows'));
  assert.match(closeBlock, /i \+= FILTER_CHUNK/);
  assert.doesNotMatch(closeBlock, /i \+= CHUNK\b/);
});

// ---------------------------------------------------------------------------
// 3. Vendor bursts — crawl order and rate limits
// ---------------------------------------------------------------------------

// Real proportions from the registry, because the fault is proportional: the
// bigger a provider's block, the longer the burst it takes.
const REAL_MIX = () => [
  ...Array.from({ length: 5271 }, (_, i) => ({ provider: 'greenhouse', token: `g${i}` })),
  ...Array.from({ length: 3014 }, (_, i) => ({ provider: 'workable', token: `w${i}` })),
  ...Array.from({ length: 525 }, (_, i) => ({ provider: 'recruitee', token: `r${i}` })),
];

test('no vendor is crawled in a long contiguous block', () => {
  // The registry comes back ordered by (provider, token) and eight workers walk
  // that order, so all eight sat on one vendor at once — times four shards, up
  // to 32 simultaneous requests at one company. Measured result: 42% of Workable
  // boards and 66% of Recruitee boards carrying HTTP 429 at any moment.
  //
  // The run length is the thing that matters, not the share of a window: a
  // provider holding 60% of the registry MUST hold about five of any eight
  // slots, and no ordering can change that. What ordering changes is whether
  // its boards arrive as one unbroken block of 5,271 or in twos.
  const boards = REAL_MIX();
  const order = interleaveByProvider(boards);

  assert.equal(order.length, boards.length, 'every board must survive');
  assert.equal(new Set(order.map((b) => b.token)).size, boards.length, 'no duplicates');

  const longestRun = (list: { provider: string }[]) => {
    let run = 1;
    let worst = 1;
    for (let i = 1; i < list.length; i++) {
      run = list[i]!.provider === list[i - 1]!.provider ? run + 1 : 1;
      if (run > worst) worst = run;
    }
    return worst;
  };

  assert.equal(longestRun(boards), 5271, 'the input really is grouped in blocks');
  assert.ok(longestRun(order) <= 3, `still bursting: run of ${longestRun(order)}`);
});

test('no vendor takes much more than its fair share of the pool', () => {
  // The pool holds 8 in flight. A vendor may hold its proportional share plus a
  // little rounding slack; well beyond that is a burst arriving anyway.
  const boards = REAL_MIX();
  const order = interleaveByProvider(boards);
  const total = boards.length;
  const size = new Map<string, number>();
  for (const b of boards) size.set(b.provider, (size.get(b.provider) ?? 0) + 1);

  const WINDOW = 8;
  const worst = new Map<string, number>();
  for (let i = 0; i + WINDOW <= order.length; i++) {
    const counts = new Map<string, number>();
    for (const b of order.slice(i, i + WINDOW)) {
      counts.set(b.provider, (counts.get(b.provider) ?? 0) + 1);
    }
    for (const [p, n] of counts) worst.set(p, Math.max(worst.get(p) ?? 0, n));
  }

  for (const [provider, peak] of worst) {
    const fair = ((size.get(provider) ?? 0) / total) * WINDOW;
    assert.ok(
      peak <= fair + 2,
      `${provider} peaked at ${peak} of ${WINDOW} against a fair share of ${fair.toFixed(1)}`,
    );
  }
});

test('the smallest provider is spread across the whole run, not drained early', () => {
  // Plain round-robin passes the test above and still fails here: it exhausts
  // the small providers in the first stretch and leaves a single-vendor tail,
  // which is the same burst arriving at the end of the run instead.
  const boards = [
    ...Array.from({ length: 5000 }, (_, i) => ({ provider: 'greenhouse', token: `g${i}` })),
    ...Array.from({ length: 500 }, (_, i) => ({ provider: 'recruitee', token: `r${i}` })),
  ];
  const order = interleaveByProvider(boards);
  const at = order.map((b, i) => (b.provider === 'recruitee' ? i : -1)).filter((i) => i >= 0);

  assert.ok(at[0]! < order.length * 0.1, 'the small provider started late');
  assert.ok(
    at[at.length - 1]! > order.length * 0.9,
    'the small provider finished long before the run did',
  );
});

test('interleaving is deterministic, so a shard still covers the same boards', () => {
  const boards = [
    ...Array.from({ length: 100 }, (_, i) => ({ provider: 'a', token: `a${i}` })),
    ...Array.from({ length: 37 }, (_, i) => ({ provider: 'b', token: `b${i}` })),
  ];
  const first = interleaveByProvider(boards).map((b) => b.token);
  const second = interleaveByProvider(boards).map((b) => b.token);
  assert.deepEqual(first, second);
});

test('a rate limit costs exactly one request, never two', async () => {
  // This test asserted the opposite this morning, and the opposite was wrong.
  //
  // Retrying once on 429 looked like the polite fix. Across three thousand
  // Workable boards it sent a second request to the vendor that had just asked
  // us to slow down: failures went from 42% to 90%, and because the crawler
  // could not then tell a refusal from a death, 2,157 live companies were
  // retired for it. Six sampled afterwards answered 200 with jobs still on them.
  //
  // Backing off is what a rate limit asks for, and that now lives in the
  // per-provider limiter — which slows every LATER request to that vendor
  // rather than hurrying this one.
  let calls = 0;
  const ctx: FetchContext = {
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: (async () => {
      calls++;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    }) as unknown as typeof fetch,
  };
  await assert.rejects(() => getJson('https://example.test/x', 'workable', 't', ctx), /HTTP 429/);
  assert.equal(calls, 1, 'a 429 must not be retried — that is what amplified the throttle');
});

test('a 404 is still answered immediately, with no rate-limit wait', async () => {
  let calls = 0;
  const ctx: FetchContext = {
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: (async () => {
      calls++;
      return new Response('gone', { status: 404 });
    }) as unknown as typeof fetch,
  };
  await assert.rejects(() => getJson('https://example.test/x', 'greenhouse', 't', ctx), /HTTP 404/);
  assert.equal(calls, 1, 'only 429 gets a second chance');
});

// ---------------------------------------------------------------------------
// 4. BambooHR dates
// ---------------------------------------------------------------------------

test('BambooHR is backfilled, because its listing has neither text nor a date', () => {
  assert.equal(needsBackfill('bamboohr'), true);
  // Unchanged for everyone else.
  assert.equal(needsBackfill('workday'), true);
  assert.equal(needsBackfill('greenhouse'), false);
  assert.equal(needsBackfill('lever'), false);
  assert.equal(needsBackfill('personio'), false);
});

test('a BambooHR detail page supplies the real posting date', async () => {
  // Sampled for real: 33 of 40 postings were older than the 21-day window and
  // the oldest was dated 2024-12-06 — every one shown as posted today, because
  // an undated row falls back to when we first saw it.
  const ctx: FetchContext = {
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: (async (url: string) => {
      assert.equal(String(url), 'https://acme.bamboohr.com/careers/489/detail');
      return new Response(
        JSON.stringify({
          result: {
            jobOpening: {
              description: '<p>Own our <b>security</b> programme.</p>',
              datePosted: '2024-12-06',
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  };

  const detail = await fetchDetail(
    { provider: 'bamboohr', token: 'acme' } as BoardRef,
    { externalId: '489', title: 'Security Engineer' } as NormalizedJob,
    ctx,
  );
  assert.ok(detail);
  assert.equal(detail.postedAt?.toISOString().slice(0, 10), '2024-12-06');
  assert.match(detail.description ?? '', /Own our security programme/);
});

test('the backfill fills a missing date and never overwrites one the vendor gave', async () => {
  const listingDate = new Date('2026-09-01T00:00:00Z');
  const undated = { externalId: '1', title: 'Data Engineer' } as NormalizedJob;
  const dated = { externalId: '2', title: 'Data Engineer', postedAt: listingDate } as NormalizedJob;

  const ctx: FetchContext = {
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ result: { jobOpening: { description: 'x', datePosted: '2024-12-06' } } }),
        { status: 200 },
      )) as unknown as typeof fetch,
  };

  await backfillDescriptions({ provider: 'bamboohr', token: 'acme' } as BoardRef, [undated, dated], ctx);

  assert.equal(undated.postedAt?.toISOString().slice(0, 10), '2024-12-06', 'gap filled');
  assert.equal(dated.postedAt, listingDate, 'a date the listing supplied must win');
});

test('a row that already has both costs no request', async () => {
  let calls = 0;
  const ctx: FetchContext = {
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  };
  const complete = {
    externalId: '3',
    title: 'Data Engineer',
    postedAt: new Date(),
    descriptionText: 'already here',
  } as NormalizedJob;

  const filled = await backfillDescriptions(
    { provider: 'bamboohr', token: 'acme' } as BoardRef,
    [complete],
    ctx,
  );
  assert.equal(filled, 0);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 2. The discovery diagnostic
// ---------------------------------------------------------------------------

let n = 0;
const result = (verdict: 'live' | 'dead' | 'unknown', status: number | null): VerifyResult => ({
  board: { provider: 'greenhouse', token: `tok${n++}`, company: 'x' },
  verdict,
  jobs: verdict === 'live' ? 5 : 0,
  status,
});

test('the verification summary reports status codes, not just verdicts', () => {
  const out = summariseVerification([
    ...Array.from({ length: 30 }, () => result('dead', 404)),
    ...Array.from({ length: 9 }, () => result('live', 200)),
    result('unknown', null),
  ]);
  assert.match(out, /live 9 · dead 30 · unclear 1/);
  assert.match(out, /HTTP 404/);
  assert.match(out, /transport error/);
  // A sample of the rejected, so a claim of "all dead" can be checked by hand.
  assert.match(out, /a sample of the rejected/);
  assert.match(out, /greenhouse:tok\d+ → HTTP 404/);
});

test('a batch with no survivors is called out as a probable block', () => {
  // The exact shape of five consecutive Greenhouse runs: "live 0 · dead 701".
  // 9 of 30 of those same tokens answered 200 with real jobs when checked by
  // hand — Airbnb, Adyen, Affirm among them — and nothing in the log said why.
  const out = summariseVerification(Array.from({ length: 701 }, () => result('dead', 403)));
  assert.match(out, /WARNING: not one of 701 boards answered/);
  assert.match(out, /HTTP 403/);
});

test('a small batch with no survivors is not called a block', () => {
  // Three dead boards is an ordinary Tuesday, not evidence of anything.
  const out = summariseVerification(Array.from({ length: 3 }, () => result('dead', 404)));
  assert.doesNotMatch(out, /WARNING/);
});

test('a healthy batch says nothing alarming', () => {
  const out = summariseVerification([
    ...Array.from({ length: 40 }, () => result('live', 200)),
    ...Array.from({ length: 20 }, () => result('dead', 404)),
  ]);
  assert.doesNotMatch(out, /WARNING/);
});
