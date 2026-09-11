import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTransientWriteError,
  readInPages,
  upsertInChunks,
} from '../src/corpus/db-feed.js';

/**
 * "Too busy right now" versus "something is actually wrong".
 *
 * Every crawl failure this project has on record is the first kind read as the
 * second. Measured 10 Sep 2026 from the Actions history:
 *
 *   8 Sep 18:46  crawl  upsert      Gateway Timeout
 *   8 Sep 01:21  crawl  close-scan  canceling statement due to statement timeout
 *   7 Sep 14:15  crawl  upsert      canceling statement due to statement timeout
 *   6 Sep 15:43  crawl  upsert      canceling statement due to statement timeout
 *
 * The halving retry landed in a491821 and fixed the third and fourth. It did not
 * fire for the first, because `Gateway Timeout` is the HTTP gateway's phrasing
 * and the predicate only knew Postgres's. It did not fire for the second either,
 * because the close-scan is a READ and had no retry at all.
 *
 * The danger in widening a rule like this is the opposite mistake: swallowing a
 * real fault. So the second half of this file is the list of things that must
 * still fail loudly on the very first attempt.
 */

const noWait = async () => {};

// ---------------------------------------------------------------------------
// What must be retried
// ---------------------------------------------------------------------------

test('the error that actually cost a shard is recognised', () => {
  // Verbatim from run 34265078745.
  assert.equal(isTransientWriteError('Gateway Timeout'), true);
});

test('both layers that can say "too busy" are recognised', () => {
  const transient = [
    // Postgres.
    'canceling statement due to statement timeout',
    'canceling statement due to conflict with recovery',
    'deadlock detected',
    'terminating connection due to administrator command',
    'server closed the connection unexpectedly',
    // The gateway in front of Postgres.
    'Gateway Timeout',
    'Gateway Time-out',
    '<html><head><title>504 Gateway Time-out</title></head></html>',
    'Bad Gateway',
    'Service Unavailable',
    'upstream connect error or disconnect/reset before headers',
    'upstream request timeout',
    // The socket.
    'ECONNRESET',
    'socket hang up',
    'fetch failed',
    'connect ETIMEDOUT 10.0.0.1:5432',
    'getaddrinfo EAI_AGAIN db.supabase.co',
    'UND_ERR_CONNECT_TIMEOUT',
  ];
  for (const m of transient) {
    assert.equal(isTransientWriteError(m), true, `should retry: ${m}`);
  }
});

test('case does not matter, because vendors are inconsistent about it', () => {
  for (const m of ['GATEWAY TIMEOUT', 'gateway timeout', 'Statement Timeout']) {
    assert.equal(isTransientWriteError(m), true, m);
  }
});

// ---------------------------------------------------------------------------
// What must still fail immediately — the risk of widening the rule
// ---------------------------------------------------------------------------

test('a real fault still fails loudly on the first attempt', () => {
  const real = [
    'duplicate key value violates unique constraint "jobs_pkey"',
    'null value in column "updated_at" violates not-null constraint',
    'column "match_digest" does not exist',
    'invalid input syntax for type timestamptz: "yesterday"',
    'new row violates row-level security policy for table "jobs"',
    'permission denied for table jobs',
    'JWT expired',
    'relation "public.jobs" does not exist',
  ];
  for (const m of real) {
    assert.equal(isTransientWriteError(m), false, `must NOT retry: ${m}`);
  }
});

test('A STATUS NUMBER INSIDE A KEY IS NOT A GATEWAY ERROR', () => {
  // The trap that kept bare numbers out of the pattern. `\b50[234]\b` is the
  // obvious way to catch 502/503/504, and our job keys look like this — so a
  // genuine constraint violation would have been retried down to the floor and
  // arrived as a confusing slow failure instead of a clear immediate one.
  const violation =
    'duplicate key value violates unique constraint "jobs_pkey" ' +
    'Key (key)=(greenhouse:acme:504) already exists.';
  assert.equal(isTransientWriteError(violation), false);
  assert.equal(
    isTransientWriteError('could not create unique index, Key (key)=(workday:ppg:502)'),
    false,
  );
});

test('an empty or junk message is not treated as transient', () => {
  for (const m of ['', '   ', 'something went wrong', 'error']) {
    assert.equal(isTransientWriteError(m), false, JSON.stringify(m));
  }
});

// ---------------------------------------------------------------------------
// The read path — which had no protection at all
// ---------------------------------------------------------------------------

const rows = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ key: `k${String(offset + i).padStart(5, '0')}` }));

test('a clean scan reads every page and stops on the empty one', async () => {
  const asked: [number, number][] = [];
  const out = await readInPages<{ key: string }>(
    async (from, size) => {
      asked.push([from, size]);
      const all = rows(2500);
      return { data: all.slice(from, from + size), error: null };
    },
    { page: 1000, wait: noWait },
  );
  assert.equal(out.length, 2500, 'every row, none skipped, none twice');
  assert.deepEqual(new Set(out.map((r) => r.key)).size, 2500, 'and no duplicates');
  assert.deepEqual(asked, [[0, 1000], [1000, 1000], [2000, 1000], [2500, 1000]]);
});

test('a page that times out is retried smaller, and the scan still completes', async () => {
  let failures = 0;
  const retries: number[] = [];
  const out = await readInPages<{ key: string }>(
    async (from, size) => {
      // The first ask at full size fails, the way it did on 8 Sep.
      if (size === 1000 && failures < 1) {
        failures++;
        return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      return { data: rows(2500).slice(from, from + size), error: null };
    },
    { page: 1000, wait: noWait, onRetry: (_s, next) => retries.push(next) },
  );
  assert.deepEqual(retries, [500], 'halved once');
  assert.equal(out.length, 2500, 'and NOTHING was skipped');
  assert.equal(new Set(out.map((r) => r.key)).size, 2500);
});

/**
 * A server that caps every page below what was asked for.
 *
 * PostgREST does exactly this — `max-rows` caps a response however large the
 * requested range — so a page that comes back SHORT in the middle of a scan is
 * a real situation and not a contrived one. It is also the only shape that
 * distinguishes the two ways of getting this loop wrong, which the two tests
 * below both missed until a mutation run showed them passing against broken
 * code.
 */
const cappedAt = (cap: number, total: number) => async (from: number, size: number) => ({
  data: rows(total).slice(from, from + Math.min(size, cap)),
  error: null,
});

test('A SHORT PAGE MUST NOT SKIP THE ROWS IT DID NOT RETURN', async () => {
  // Advancing by the size REQUESTED rather than the rows RECEIVED steps over
  // real postings. A posting the close-scan misses is one the crawl believes
  // the employer has withdrawn, so this silently closes live jobs.
  const out = await readInPages<{ key: string }>(cappedAt(300, 1200), {
    page: 1000,
    wait: noWait,
  });
  assert.equal(out.length, 1200, 'every row, despite pages arriving three-tenths the size asked');
  assert.deepEqual(
    out.map((r) => r.key),
    rows(1200).map((r) => r.key),
    'in order, with no hole',
  );
});

test('A SHORT PAGE MUST NOT END THE SCAN', async () => {
  // Stopping on a short page truncates the scan at the first cap — here after
  // 300 of 1,200 rows, leaving 900 live postings unaccounted for.
  const out = await readInPages<{ key: string }>(cappedAt(300, 1200), {
    page: 1000,
    wait: noWait,
  });
  assert.equal(out.length, 1200, 'the scan continues past the first short page');
});

test('the retry restarts at the same offset it failed on', async () => {
  const asked: [number, number][] = [];
  let first = true;
  await readInPages<{ key: string }>(
    async (from, size) => {
      asked.push([from, size]);
      if (first) {
        first = false;
        return { data: null, error: { message: 'Gateway Timeout' } };
      }
      return { data: rows(1200).slice(from, from + size), error: null };
    },
    { page: 1000, wait: noWait },
  );
  assert.deepEqual(asked[0], [0, 1000], 'asked for a full page');
  assert.deepEqual(asked[1], [0, 500], 'and after the refusal, the SAME offset, half the size');
});

test('a real fault in the read path fails at once, unretried', async () => {
  let calls = 0;
  await assert.rejects(
    readInPages<{ key: string }>(
      async () => {
        calls++;
        return { data: null, error: { message: 'column "board_token" does not exist' } };
      },
      { page: 1000, wait: noWait },
    ),
    /close-scan failed: column "board_token" does not exist/,
  );
  assert.equal(calls, 1, 'tried once and gave up, rather than halving eight times');
});

test('a database that refuses every size eventually throws, never silently truncates', async () => {
  const sizes: number[] = [];
  await assert.rejects(
    readInPages<{ key: string }>(
      async (_from, size) => {
        sizes.push(size);
        return { data: null, error: { message: 'Gateway Timeout' } };
      },
      { page: 1000, floor: 125, wait: noWait },
    ),
    /close-scan failed: Gateway Timeout/,
  );
  assert.deepEqual(sizes, [1000, 500, 250, 125], 'halves to the floor, then throws');
});

test('an empty table is a valid answer, not a failure', async () => {
  const out = await readInPages<{ key: string }>(async () => ({ data: [], error: null }), {
    wait: noWait,
  });
  assert.deepEqual(out, []);
});

test('a null data payload with no error is treated as empty', async () => {
  const out = await readInPages<{ key: string }>(async () => ({ data: null, error: null }), {
    wait: noWait,
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// The write path keeps the behaviour it had, plus the gateway error
// ---------------------------------------------------------------------------

test('the write path now halves on a Gateway Timeout too', async () => {
  const sizes: number[] = [];
  const written = await upsertInChunks(
    rows(600),
    async (chunk) => {
      sizes.push(chunk.length);
      if (chunk.length > 250) return { error: { message: 'Gateway Timeout' }, count: null };
      return { error: null, count: chunk.length };
    },
    { chunk: 500, floor: 25, wait: noWait },
  );
  assert.equal(written, 600, 'every row written, none dropped');
  // The real sequence, observed rather than assumed. Each new POSITION starts
  // again at the full chunk size, so a sustained refusal costs one failed
  // statement per position before it halves:
  //
  //   500 refused → 250 written → 350 refused → 175 written → 175 written
  //
  // That is the behaviour a491821 shipped and this change does not alter it.
  // Noted here because it is a real inefficiency under sustained pressure — the
  // read path below deliberately does the opposite and keeps the smaller size.
  assert.deepEqual(sizes, [500, 250, 350, 175, 175]);
});

test('the read path REMEMBERS the smaller page, unlike the write path', async () => {
  // Deliberate difference. A scan makes dozens of requests in a row against the
  // same conditions, so re-learning the size on every page would mean dozens of
  // failed statements. A write is one position at a time and the contention it
  // hit may be gone by the next.
  const asked: number[] = [];
  const out = await readInPages<{ key: string }>(
    async (from, size) => {
      asked.push(size);
      if (size === 1000) return { data: null, error: { message: 'Gateway Timeout' } };
      return { data: rows(1500).slice(from, from + size), error: null };
    },
    { page: 1000, wait: noWait },
  );
  assert.equal(out.length, 1500);
  assert.deepEqual(asked, [1000, 500, 500, 500, 500], 'one failure, then 500 for the rest');
});

test('the write path still refuses to swallow a constraint violation', async () => {
  let calls = 0;
  await assert.rejects(
    upsertInChunks(
      rows(100),
      async () => {
        calls++;
        return {
          error: { message: 'duplicate key value violates unique constraint "jobs_pkey"' },
          count: null,
        };
      },
      { chunk: 100, floor: 25, wait: noWait },
    ),
    /upsert failed: duplicate key/,
  );
  assert.equal(calls, 1);
});
