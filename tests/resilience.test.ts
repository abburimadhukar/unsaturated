import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getJson, retryAfterMs } from '../src/ats/http.js';
import { AtsFetchError, failureKindFor, type FetchContext } from '../src/ats/types.js';
import { KNOWN_BUDGETS, ProviderLimiter } from '../src/corpus/rate-limit.js';
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
  // greenhouse, not workable: this is the ADAPTIVE path, for a vendor whose
  // limit is unknown. Workable's is published, so it starts there and has
  // nothing to discover — that is covered separately below.
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100, maxGapMs: 4000 });
  l.refused('greenhouse');
  const [w] = l.report();
  assert.equal(w?.provider, 'greenhouse');
  assert.equal(w?.concurrency, 4);
  assert.equal(w?.gapMs, 200);
  l.refused('greenhouse');
  assert.equal(l.report()[0]?.concurrency, 2);
  assert.equal(l.report()[0]?.gapMs, 400);
});

test('backing off never stalls a provider completely', () => {
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100, maxGapMs: 1000 });
  for (let i = 0; i < 40; i++) l.refused('greenhouse');
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
  // And workable bottoming out did not touch anyone else's pace.
  const gh = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100 });
  for (let i = 0; i < 5; i++) gh.refused('workable');
  gh.succeeded('greenhouse');
  assert.equal(gh.report().some((r) => r.provider === 'greenhouse'), false);
});

test('recovery is slow, and only after sustained success', () => {
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 100, recoverAfter: 10 });
  l.refused('greenhouse');
  assert.equal(l.report()[0]?.concurrency, 4);

  for (let i = 0; i < 9; i++) l.succeeded('greenhouse');
  assert.equal(l.report()[0]?.concurrency, 4, 'nine clean responses is not enough');

  l.succeeded('greenhouse');
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
  // Inside the lane, so the gate is the lane's own vendor.
  assert.match(src, /await limiter\.acquire\(provider\);/);
  // In a finally, or one thrown error leaks a slot and that vendor deadlocks —
  // and with lanes a deadlocked vendor stalls only itself, which is quieter and
  // therefore easier to miss.
  assert.match(src, /finally \{\s*limiter\.release\(provider\);/);
  assert.match(src, /limiter\.refused\(\s*provider,/);
  assert.match(src, /limiter\.succeeded\(provider\)/);
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

// ---------------------------------------------------------------------------
// Lanes: one pool per vendor, all running at once
// ---------------------------------------------------------------------------

test('a published limit is the starting point, not something to rediscover', () => {
  // The limiter finds a ceiling by exceeding it and retreating, which is right
  // when nothing is known and wrong when something is. Opening at 8 in flight
  // 120ms apart is ~60 requests a second against Workable's published
  // 10-per-10-seconds: we blew the budget in the first second of every crawl
  // and spent the rest of it being refused.
  const l = new ProviderLimiter({ startConcurrency: 8, startGapMs: 120 });
  l.refused('workable');
  const w = l.report().find((r) => r.provider === 'workable');
  // Started at 1/1000ms from KNOWN_BUDGETS, so one refusal cannot take it below
  // the floor — it was already there.
  assert.equal(KNOWN_BUDGETS.workable?.concurrency, 1);
  assert.equal(KNOWN_BUDGETS.workable?.gapMs, 1000);
  assert.equal(w?.concurrency, 1);

  // A vendor we know nothing about still starts at the general pace.
  l.refused('greenhouse');
  assert.equal(l.report().find((r) => r.provider === 'greenhouse')?.concurrency, 4);
});

test('recovery never climbs past a vendor’s published rate', () => {
  // Easing a KNOWN limit upward is exactly how this went wrong.
  const l = new ProviderLimiter({ startConcurrency: 8, recoverAfter: 2 });
  for (let i = 0; i < 200; i++) l.succeeded('workable');
  const w = l.report().find((r) => r.provider === 'workable');
  // Either it never appears (never refused, never changed) or it is still at 1.
  assert.ok(!w || w.concurrency === 1, `workable crept up to ${w?.concurrency}`);
});

test('every vendor gets its own lane, so one slow one cannot block the rest', () => {
  const src = readFileSync(new URL('../src/corpus/live.ts', import.meta.url), 'utf8');
  // Boards are grouped by provider and the groups run concurrently.
  assert.match(src, /const lanes = new Map<string, CorpusBoard\[\]>\(\)/);
  assert.match(src, /\[\.\.\.lanes\]\.map\(async \(\[provider, list\]\)/);
  // The old shared cursor over one interleaved list is gone — that was the
  // thing that made Workable's pace everyone's pace.
  assert.doesNotMatch(src, /while \(cursor < boards\.length\)/);
});

test('a lane that runs out of time says so instead of looking complete', () => {
  const src = readFileSync(new URL('../src/corpus/live.ts', import.meta.url), 'utf8');
  assert.match(src, /unfinished/);
  assert.match(src, /read \$\{u\.done\} of \$\{u\.total\} boards/);
});

// ---------------------------------------------------------------------------
// The diagnostic: what the vendor actually said
// ---------------------------------------------------------------------------

test('a refusal keeps the vendor’s own explanation', async () => {
  // We spent a day guessing at Workable's budget from a laptop, where it
  // refuses nothing at 40 requests a second, while production is refused
  // constantly. The vendor is the only one who knows, and it usually says.
  const c: FetchContext = {
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: (async () =>
      new Response('{"error":"too many requests from this network"}', {
        status: 429,
        headers: {
          'retry-after': '30',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1757200000',
          'content-type': 'application/json',
        },
      })) as unknown as typeof fetch,
  };

  await assert.rejects(
    () => getJson('https://x.test/a', 'workable', 't', c),
    (err: AtsFetchError) => {
      assert.equal(err.detail?.status, 429);
      assert.equal(err.detail?.retryAfter, '30');
      assert.equal(err.detail?.limitHeaders?.['x-ratelimit-remaining'], '0');
      assert.match(err.detail?.body ?? '', /too many requests from this network/);
      return true;
    },
  );
});

test('a 404 carries no explanation, because it has none to give', async () => {
  const c: FetchContext = {
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch,
  };
  await assert.rejects(
    () => getJson('https://x.test/a', 'greenhouse', 't', c),
    (err: AtsFetchError) => err.detail === undefined && err.failure === 'gone',
  );
});

test('the vendor’s explanation is kept once, not once per board', () => {
  const l = new ProviderLimiter();
  l.refused('workable', null, { status: 429, retryAfter: '30' });
  l.refused('workable', null, { status: 429, retryAfter: '999' });
  const w = l.report().find((r) => r.provider === 'workable');
  assert.equal(w?.firstRefusal?.retryAfter, '30', 'later copies must not overwrite the first');
  assert.equal(w?.refusals, 2, 'but every refusal is still counted');
});

test('the run prints what a refusing vendor said', () => {
  const src = readFileSync(new URL('../src/corpus/live.ts', import.meta.url), 'utf8');
  assert.match(src, /what \$\{r\.provider\} actually said/);
  assert.match(src, /retry-after/);
});

// ---------------------------------------------------------------------------
// One company, one board — however the archive spells it
// ---------------------------------------------------------------------------

test('a board is the same board whatever case the archive used', async () => {
  // These APIs are case-insensitive. Verified 7 Sep 2026: ashby/accord and
  // ashby/Accord both return the same 4 jobs, greenhouse/babylist and
  // greenhouse/Babylist the same 46, smartrecruiters/bluescope and
  // smartrecruiters/BlueScope the same 37.
  //
  // The dedup key was not, so the archive holding both spellings stored each as
  // a separate board — and because a job key is provider:token:id, both copies
  // stored the SAME posting twice and both reached the site. 317 such pairs
  // exist today; AbbVie appears twice with 41 jobs each.
  const cli = readFileSync(new URL('../src/cli/harvest-cc.ts', import.meta.url), 'utf8');
  const fn = cli.slice(cli.indexOf('const keyOf ='), cli.indexOf('async function main'));
  assert.match(fn, /b\.token\.toLowerCase\(\)/);
  // Workday's identity is tenant AND site, so both halves have to fold.
  assert.match(fn, /\(b\.extra\?\.site \?\? ''\)\.toLowerCase\(\)/);
});

test('the stored token keeps the case the vendor printed', () => {
  // Only the COMPARISON folds. SmartRecruiters tokens are mixed-case by nature
  // — "ATParchitekteningenieure" — and rewriting what a vendor published buys
  // nothing.
  const cc = readFileSync(new URL('../src/discovery/commoncrawl.ts', import.meta.url), 'utf8');
  const toBoard = cc.slice(cc.indexOf('function toBoard'), cc.indexOf('export interface HarvestReport'));
  assert.doesNotMatch(toBoard, /token: m\[1\]\.toLowerCase\(\)/);
  assert.doesNotMatch(toBoard, /token\.toLowerCase\(\)/);
});

test('SmartRecruiters’ second domain is harvested', () => {
  // 424 tokens on careers.smartrecruiters.com, 234 unregistered, 18 of 18
  // sampled live with 501 jobs between them — on the richest provider in the
  // registry at 9.22 jobs per board against Greenhouse's 2.52.
  const cc = readFileSync(new URL('../src/discovery/commoncrawl.ts', import.meta.url), 'utf8');
  assert.match(cc, /match: 'careers\.smartrecruiters\.com\/\*'/);
  assert.match(cc, /match: 'jobs\.smartrecruiters\.com\/\*'/);

  // And the extraction takes the first path segment, as the sample shows.
  const rx = /careers\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)/;
  assert.equal(
    rx.exec('https://careers.smartrecruiters.com/ATParchitekteningenieure')?.[1],
    'ATParchitekteningenieure',
  );
  assert.equal(rx.exec('https://careers.smartrecruiters.com/A2Design/')?.[1], 'A2Design');
  // The bare search URL has no company in it and must yield nothing.
  assert.equal(rx.exec('https://careers.smartrecruiters.com/?search=&page=0'), null);
});

test('dedupe keeps the copy the site is already showing, and closes the other', () => {
  const src = readFileSync(new URL('../src/cli/boards-dedupe.ts', import.meta.url), 'utf8');
  // Most stored jobs wins, with the token breaking ties so two runs agree.
  assert.match(src, /b\.jobs - a\.jobs \|\| a\.token\.localeCompare\(b\.token\)/);
  // Closing the loser's postings matters more than deactivating it —
  // deactivating alone leaves the duplicates on the site for the full
  // retention window, which is the entire problem.
  assert.match(src, /closed_at: new Date\(\)\.toISOString\(\)/);
  assert.match(src, /active: false/);
  // And it must be runnable without writing anything.
  assert.match(src, /--dry-run/);
});

test('the weekly re-check can still retire a board that is genuinely gone', () => {
  // Retirement counts only 'gone', and this pass passed `ok: false` with no
  // kind at all — so every dead verdict read as "refused" and the one job this
  // pass exists for quietly stopped working. Nothing failed; it just never
  // retired anything again.
  const src = readFileSync(new URL('../src/cli/boards-verify.ts', import.meta.url), 'utf8');
  assert.match(src, /failure: failureKindFor\(r\.status \?\? undefined\)/);
  // Classified by status, not assumed — a 403 is user-agent filtering and must
  // not retire a live board here either.
  assert.match(src, /import \{ failureKindFor \}/);
});
