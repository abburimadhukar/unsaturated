import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  failureReason,
  groupByReason,
  planFailureWrites,
  recordCrawlOutcomes,
  type FailureWrite,
} from '../src/corpus/board-store.js';
import { workdayAdapter } from '../src/ats/adapters/workday.js';
import { getAdapter } from '../src/ats/adapters/index.js';
import { AtsFetchError } from '../src/ats/types.js';
import type { dbWrite } from '../src/db/supabase.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * Who is allowed to end a company's life in the registry.
 *
 * This project has retired live employers twice.
 *
 *   6 Sep 2026 — 2,185 of 2,263 retired boards carried an HTTP 429. A rate
 *   limit, read as a closure. Every one sampled afterwards answered 200 with
 *   jobs on it. Fixed by splitting 'refused' from 'gone'.
 *
 *   8 Sep 2026 — the split held, and 44 more boards were retired anyway.
 *   Workday refuses by serving an HTML challenge page where JSON belongs, which
 *   is not a status code, so no refusal rule saw it. Probed live that day, 44 of
 *   the 81 boards retired for failing answered HTTP 200 with 7,871 jobs between
 *   them: spartannash 1,118, virtua 740, ppg 712, yai 501, upenn 237.
 *
 * The second one is the reason for the rule these tests cover. Both times the
 * verdict came from the hourly crawl, which takes 25,000 hurried looks under
 * vendor rate limits. It no longer gets a vote: it records what it saw, and
 * `boards:verify` — one request a second, a real HTTP status or nothing —
 * decides. The counter that ends in retirement now only ever counts that pass's
 * observations, so a hurried look cannot put a board four fifths of the way to
 * death before a careful one has ever run.
 */

const MAX = 5;

// ---------------------------------------------------------------------------
// The rule, on its own
// ---------------------------------------------------------------------------

const at = (...pairs: [string, number][]) => new Map(pairs);
const tokens = (...t: string[]) => t.map((token) => ({ token }));
const find = (plan: FailureWrite[], failures: number) =>
  plan.find((w) => w.failures === failures);

test('a first failure is a long way from retirement', () => {
  const plan = planFailureWrites(tokens('ppg'), at(['ppg', 0]), MAX);
  assert.deepEqual(plan, [{ failures: 1, reason: 'failed', tokens: ['ppg'], retire: false }]);
});

test('the strike before last does not retire', () => {
  const plan = planFailureWrites(tokens('ppg'), at(['ppg', 3]), MAX);
  assert.equal(find(plan, 4)?.retire, false);
});

test('the last strike retires', () => {
  const plan = planFailureWrites(tokens('ppg'), at(['ppg', 4]), MAX);
  assert.equal(find(plan, 5)?.retire, true);
});

test('a board already past the limit stays retired rather than escaping', () => {
  // These exist: seven boards sit at 8 and 9 failures because discovered-boards.json
  // re-adds them to the crawl list after the registry has dropped them.
  const plan = planFailureWrites(tokens('clickhouse'), at(['clickhouse', 8]), MAX);
  assert.equal(find(plan, 9)?.retire, true);
});

test('a board the registry has never heard of is skipped, not inserted', () => {
  // It came from discovered-boards.json, which the crawl list is merged with.
  // There is no row, and it carries no company (NOT NULL) or Workday site, so
  // inserting a half-formed one is worse than recording nothing.
  assert.deepEqual(planFailureWrites(tokens('ghost'), at(['ppg', 0]), MAX), []);
});

test('ONE tenant failing on two career sites is one strike, not two', () => {
  // The bug this guards: a Workday token is a tenant, and Ochsner runs
  // `Ochsner` (1,917 jobs) and `ochsnerphysician` (346) under the same token.
  // Both failing arrives as two outcomes for one token. Counted twice, a tenant
  // with two sites would reach the limit in half the runs of a tenant with one.
  const plan = planFailureWrites(tokens('ochsner', 'ochsner'), at(['ochsner', 3]), MAX);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { failures: 4, reason: 'failed', tokens: ['ochsner'], retire: false });
});

test('a tenant with two sites cannot be pushed over the line by the duplicate', () => {
  const plan = planFailureWrites(tokens('nshe', 'nshe', 'nshe'), at(['nshe', 3]), MAX);
  assert.equal(find(plan, 4)?.retire, false, 'three sites, one strike, still alive');
  assert.equal(find(plan, 5), undefined, 'and nothing lands on the retiring count');
});

test('boards are grouped by the count they land on, in order', () => {
  const plan = planFailureWrites(
    tokens('a', 'b', 'c', 'd'),
    at(['a', 0], ['b', 4], ['c', 0], ['d', 1]),
    MAX,
  );
  assert.deepEqual(
    plan.map((w) => [w.failures, w.tokens, w.retire]),
    [
      [1, ['a', 'c'], false],
      [2, ['d'], false],
      [5, ['b'], true],
    ],
  );
});

test('nothing failing produces no statements', () => {
  assert.deepEqual(planFailureWrites([], at(['ppg', 4]), MAX), []);
});

test('a limit of one retires on the first strike, and a huge limit never does', () => {
  assert.equal(planFailureWrites(tokens('x'), at(['x', 0]), 1)[0]?.retire, true);
  assert.equal(planFailureWrites(tokens('x'), at(['x', 99]), 1_000_000)[0]?.retire, false);
});

// ---------------------------------------------------------------------------
// Whose error is it — the second bug, and the one the repair reads
// ---------------------------------------------------------------------------

test('a board no longer carries another board\'s name', () => {
  // Measured 8 Sep: 44 of the 74 retired boards with an attributable error named
  // a DIFFERENT board. workday:ppg said the failure came from workday/catalent.
  assert.equal(
    failureReason("workday/catalent: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"),
    "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
  );
});

test('boards that failed the same way still share one statement', () => {
  // The batching was never the problem, the shared TEXT was. Strip the name and
  // the remainder is true of all of them, so the write stays cheap.
  const groups = groupByReason([
    { token: 'ppg', error: "workday/ppg: HTTP 429 (429 is rate limiting)" },
    { token: 'yai', error: "workday/yai: HTTP 429 (429 is rate limiting)" },
    { token: 'upenn', error: 'workday/upenn: HTTP 404 (wrong tenant token)' },
  ]);
  assert.equal(groups.length, 2, 'two reasons, two statements — not three, not one');
  const rate = groups.find((g) => g.reason.startsWith('HTTP 429'));
  assert.deepEqual(rate?.tokens, ['ppg', 'yai']);
  assert.deepEqual(groups.find((g) => g.reason.startsWith('HTTP 404'))?.tokens, ['upenn']);
});

test('a failure with no message recorded says so, rather than nothing', () => {
  assert.equal(failureReason(undefined), 'failed');
  assert.equal(failureReason(''), 'failed');
  assert.equal(failureReason('   '), 'failed');
  // Prefix and nothing else: do not store an empty string.
  assert.equal(failureReason('workday/ppg: '), 'failed');
});

test('a message that is not prefixed is left exactly as it is', () => {
  assert.equal(failureReason('socket hang up'), 'socket hang up');
  // A URL in the text is not a provider prefix and must survive.
  assert.equal(
    failureReason('https://ppg.wd5.myworkdayjobs.com/x failed'),
    'https://ppg.wd5.myworkdayjobs.com/x failed',
  );
});

test('the stored reason is capped, like the column it goes into', () => {
  assert.equal(failureReason('workday/ppg: ' + 'x'.repeat(500)).length, 300);
});

test('two boards failing differently never share a statement', () => {
  // The case that made this urgent: one board refused, its neighbour genuinely
  // 404. Sharing text meant the 404 could be revived and the refusal left dead.
  const plan = planFailureWrites(
    [
      { token: 'ppg', error: 'workday/ppg: HTTP 429' },
      { token: 'trails', error: 'greenhouse/trails: HTTP 404' },
    ],
    at(['ppg', 0], ['trails', 0]),
    MAX,
  );
  assert.equal(plan.length, 2, 'same failure count, different reasons, two statements');
  assert.deepEqual(plan.find((p) => p.reason === 'HTTP 429')?.tokens, ['ppg']);
  assert.deepEqual(plan.find((p) => p.reason === 'HTTP 404')?.tokens, ['trails']);
});

test('the same reason at different failure counts stays separate', () => {
  const plan = planFailureWrites(
    [
      { token: 'a', error: 'workday/a: HTTP 429' },
      { token: 'b', error: 'workday/b: HTTP 429' },
    ],
    at(['a', 0], ['b', 3]),
    MAX,
  );
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => [p.failures, p.tokens]), [[1, ['a']], [4, ['b']]]);
});

// ---------------------------------------------------------------------------
// The write path, against a fake PostgREST
// ---------------------------------------------------------------------------

interface Statement {
  table: string;
  verb: 'update' | 'select';
  patch?: Record<string, unknown>;
  columns?: string;
  provider?: string;
  tokens?: string[];
}

/**
 * Enough of supabase-js to record what would have been written.
 *
 * The chain is `.from(t).update(patch, opts).eq(col, v).in(col, arr)` and the
 * final link is awaited, so every link returns the same thenable recorder.
 */
function fakeClient(rows: { provider: string; token: string; consecutive_failures: number }[]) {
  const statements: Statement[] = [];

  const builder = (st: Statement) => {
    const self = {
      eq(col: string, val: string) {
        if (col === 'provider') st.provider = val;
        return self;
      },
      in(_col: string, arr: string[]) {
        st.tokens = arr;
        return self;
      },
      then(resolve: (r: unknown) => void) {
        if (st.verb === 'select') {
          const data = rows
            .filter((r) => r.provider === st.provider && (st.tokens ?? []).includes(r.token))
            .map((r) => ({ token: r.token, consecutive_failures: r.consecutive_failures }));
          resolve({ data, error: null });
          return;
        }
        resolve({ error: null, count: (st.tokens ?? []).length });
      },
    };
    return self;
  };

  const client = {
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          const st: Statement = { table, verb: 'update', patch };
          statements.push(st);
          return builder(st);
        },
        select(columns: string) {
          const st: Statement = { table, verb: 'select', columns };
          statements.push(st);
          return builder(st);
        },
      };
    },
  };

  return { client: client as unknown as ReturnType<typeof dbWrite>, statements };
}

const updates = (s: Statement[]) => s.filter((x) => x.verb === 'update');
const retiring = (s: Statement[]) => updates(s).filter((x) => x.patch?.active === false);
const patchFor = (s: Statement[], token: string) =>
  updates(s).find((x) => (x.tokens ?? []).includes(token))?.patch;

const gone = (token: string, error = "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON") =>
  ({ provider: 'workday', token, ok: false, jobs: 0, error, failure: 'gone' as const });
const refused = (token: string, error = 'HTTP 429') =>
  ({ provider: 'workday', token, ok: false, jobs: 0, error, failure: 'refused' as const });
const answered = (token: string, jobs = 12) =>
  ({ provider: 'workday', token, ok: true, jobs });

/**
 * Rows the fake database already holds. Provider defaults to workday because
 * most of these cases are Workday boards; pass it explicitly where the provider
 * is part of what is being tested, or the select finds nothing and the test
 * passes for the wrong reason.
 */
const registry = (...pairs: ([string, number] | [string, number, string])[]) =>
  pairs.map(([token, consecutive_failures, provider]) => ({
    provider: provider ?? 'workday',
    token,
    consecutive_failures,
  }));

test('THE CRAWL RETIRES NOTHING, even a board on its last strike', async () => {
  // spartannash was one of the 44. It answered HTTP 200 with 1,118 jobs on
  // 8 Sep, while sitting retired on five crawl strikes.
  const { client, statements } = fakeClient(registry(['spartannash', 4]));
  const res = await recordCrawlOutcomes([gone('spartannash')], MAX, { client });

  assert.equal(retiring(statements).length, 0, 'no statement may write active: false');
  assert.equal(res.deactivated, 0);
});

test('the crawl retires nothing when it does not think about it at all', async () => {
  // The default. A caller that forgets the option gets the answer that never
  // costs a live board.
  const { client, statements } = fakeClient(registry(['ppg', 4]));
  const res = await recordCrawlOutcomes([gone('ppg')], MAX, { client });
  assert.equal(retiring(statements).length, 0);
  assert.equal(res.deactivated, 0);
});

test('the crawl does not advance the counter either', async () => {
  // The counter has to keep meaning "failures seen by the pass entitled to
  // retire on them". If the crawl fed it, a board would arrive at the careful
  // pass already one strike from death, and the first 404 there would end it —
  // the same bug wearing a different coat.
  const { client, statements } = fakeClient(registry(['virtua', 4]));
  await recordCrawlOutcomes([gone('virtua')], MAX, { client });

  const patch = patchFor(statements, 'virtua');
  assert.ok(patch, 'the board is still written to');
  assert.equal('consecutive_failures' in patch, false, 'but its strike count is untouched');
  assert.equal('active' in patch, false);
});

test('the crawl still records what it saw, so the run stays honest', async () => {
  const { client, statements } = fakeClient(registry(['upenn', 2]));
  await recordCrawlOutcomes([gone('upenn')], MAX, { client });

  const patch = patchFor(statements, 'upenn');
  assert.ok(patch?.last_crawled_at, 'the timestamp is recorded');
  assert.match(String(patch?.last_error), /DOCTYPE/, "and the vendor's own words");
});

test('the crawl counts what looked gone, so the number is never silent', async () => {
  const { client } = fakeClient(registry(['a', 0], ['b', 0], ['c', 0]));
  const res = await recordCrawlOutcomes([gone('a'), gone('b'), refused('c')], MAX, { client });

  assert.equal(res.looksGone, 2, 'reported for the log');
  assert.equal(res.deactivated, 0, 'and acted on by nobody');
  assert.equal(res.spared, 3, 'all three failures were kept');
});

test('the crawl never reads the counter it is not allowed to change', async () => {
  // Not cosmetic: the read is a statement per 200 boards against a database
  // that has twice failed a crawl on a statement timeout.
  const { client, statements } = fakeClient(registry(['ppg', 4]));
  await recordCrawlOutcomes([gone('ppg')], MAX, { client });
  assert.equal(statements.filter((s) => s.verb === 'select').length, 0);
});

test('THE VERIFICATION PASS may retire, and does', async () => {
  const { client, statements } = fakeClient(registry(['trails', 4]));
  const res = await recordCrawlOutcomes([gone('trails')], MAX, { client, mayRetire: true });

  assert.equal(res.deactivated, 1);
  const patch = patchFor(statements, 'trails');
  assert.equal(patch?.active, false);
  assert.equal(patch?.consecutive_failures, 5);
});

test('the verification pass still spares a board that only refused', async () => {
  // 403 and 429 come back as 'refused'. Ten of them in a row must not retire —
  // this is the 2,185-board bug, and it must stay fixed on the one path that
  // can still retire.
  const { client, statements } = fakeClient(registry(['ncino', 10]));
  const res = await recordCrawlOutcomes([refused('ncino', 'HTTP 403')], MAX, {
    client,
    mayRetire: true,
  });

  assert.equal(retiring(statements).length, 0);
  assert.equal(res.deactivated, 0);
  assert.equal(res.spared, 1);
});

test('a failure with no kind recorded is never fatal', async () => {
  // `failure` is optional. An outcome that never set it must fall to the safe
  // side on the pass that can retire, not the fatal one.
  const { client, statements } = fakeClient(registry(['mystery', 4]));
  const res = await recordCrawlOutcomes(
    [{ provider: 'workday', token: 'mystery', ok: false, jobs: 0, error: 'something' }],
    MAX,
    { client, mayRetire: true },
  );
  assert.equal(retiring(statements).length, 0);
  assert.equal(res.deactivated, 0);
});

test('comcast stays dead — the case this class of fix keeps getting wrong', async () => {
  // Verified 8 Sep 2026: workday:comcast answers HTTP 410. It is genuinely gone
  // and must retire when the careful pass says so.
  const { client, statements } = fakeClient(registry(['comcast', 4]));
  await recordCrawlOutcomes([gone('comcast', 'workday/comcast: HTTP 410')], MAX, {
    client,
    mayRetire: true,
  });
  assert.equal(patchFor(statements, 'comcast')?.active, false);
});

test('one tenant, two failing sites, one strike — through the whole write path', async () => {
  const { client, statements } = fakeClient(registry(['ochsner', 3]));
  await recordCrawlOutcomes([gone('ochsner'), gone('ochsner')], MAX, {
    client,
    mayRetire: true,
  });

  const written = updates(statements).filter((s) => (s.tokens ?? []).includes('ochsner'));
  assert.equal(written.length, 1, 'one statement, not two');
  assert.equal(written[0]?.patch?.consecutive_failures, 4);
  assert.equal(retiring(statements).length, 0, 'and nowhere near retirement');
});

test('a board that answered is reset and cleared, on both passes', async () => {
  for (const mayRetire of [false, true]) {
    const { client, statements } = fakeClient(registry(['ppg', 4]));
    await recordCrawlOutcomes([answered('ppg')], MAX, { client, mayRetire });

    const patch = patchFor(statements, 'ppg');
    assert.equal(patch?.consecutive_failures, 0, `reset (mayRetire=${mayRetire})`);
    assert.equal(patch?.last_error, null);
    assert.ok(patch?.last_ok_at);
    assert.equal(retiring(statements).length, 0);
  }
});

test('a mixed run writes each board the right way and retires only the gone one', async () => {
  const { client, statements } = fakeClient(
    registry(['healthy', 2], ['ratelimited', 4], ['dead', 4]),
  );
  const res = await recordCrawlOutcomes(
    [answered('healthy'), refused('ratelimited'), gone('dead')],
    MAX,
    { client, mayRetire: true },
  );

  assert.equal(patchFor(statements, 'healthy')?.consecutive_failures, 0);
  assert.equal('active' in (patchFor(statements, 'ratelimited') ?? {}), false);
  assert.equal(patchFor(statements, 'dead')?.active, false);
  assert.equal(res.deactivated, 1);
});

test('the same mixed run retires nobody on the crawl', async () => {
  const { client, statements } = fakeClient(
    registry(['healthy', 2], ['ratelimited', 4], ['dead', 4]),
  );
  const res = await recordCrawlOutcomes(
    [answered('healthy'), refused('ratelimited'), gone('dead')],
    MAX,
    { client },
  );
  assert.equal(retiring(statements).length, 0);
  assert.equal(res.deactivated, 0);
});

test('two providers sharing a token never land in one statement', async () => {
  // Tokens are only unique within a provider. `greenhouse:up` is retired and
  // `ashby:up` would be a different company entirely.
  const { client, statements } = fakeClient([
    { provider: 'greenhouse', token: 'up', consecutive_failures: 4 },
    { provider: 'ashby', token: 'up', consecutive_failures: 0 },
  ]);
  await recordCrawlOutcomes(
    [
      { provider: 'greenhouse', token: 'up', ok: false, jobs: 0, failure: 'gone' },
      { provider: 'ashby', token: 'up', ok: true, jobs: 9 },
    ],
    MAX,
    { client, mayRetire: true },
  );

  const retired = retiring(statements);
  assert.equal(retired.length, 1);
  assert.equal(retired[0]?.provider, 'greenhouse', 'and it is the greenhouse row');
});

test('a failing board is written exactly once, whichever pass is running', async () => {
  // The two branches must stay disjoint. With mayRetire false the gone boards
  // move into the recorded-only branch, and if the counted branch still claimed
  // them the board would take two UPDATEs — the second one carrying `active`.
  for (const mayRetire of [false, true]) {
    const { client, statements } = fakeClient(registry(['ppg', 1]));
    const res = await recordCrawlOutcomes([gone('ppg')], MAX, { client, mayRetire });

    const touching = updates(statements).filter((s) => (s.tokens ?? []).includes('ppg'));
    assert.equal(touching.length, 1, `one UPDATE only (mayRetire=${mayRetire})`);
    assert.equal(res.recorded, 1, 'and it is counted once, not twice');
  }
});

test('a mixed batch writes each board once and counts each board once', async () => {
  for (const mayRetire of [false, true]) {
    const { client, statements } = fakeClient(registry(['a', 0], ['b', 0], ['c', 0]));
    const res = await recordCrawlOutcomes([answered('a'), refused('b'), gone('c')], MAX, {
      client,
      mayRetire,
    });

    for (const token of ['a', 'b', 'c']) {
      const touching = updates(statements).filter((s) => (s.tokens ?? []).includes(token));
      assert.equal(touching.length, 1, `${token} written once (mayRetire=${mayRetire})`);
    }
    assert.equal(res.recorded, 3);
    assert.equal(res.looksGone, 1, 'and the gone one is reported either way');
  }
});

test('through the write path, each board is told the truth about itself', async () => {
  // The whole point. ppg was rate limited, trails is genuinely gone, and neither
  // row may end up carrying the other's story — boards-revive reads this text.
  for (const mayRetire of [false, true]) {
    const { client, statements } = fakeClient(registry(['ppg', 0], ['trails', 0]));
    await recordCrawlOutcomes(
      [
        { provider: 'workday', token: 'ppg', ok: false, jobs: 0, error: 'workday/ppg: HTTP 429', failure: 'refused' },
        { provider: 'workday', token: 'trails', ok: false, jobs: 0, error: 'workday/trails: HTTP 404', failure: 'gone' },
      ],
      MAX,
      { client, mayRetire },
    );

    assert.equal(patchFor(statements, 'ppg')?.last_error, 'HTTP 429', `mayRetire=${mayRetire}`);
    assert.equal(patchFor(statements, 'trails')?.last_error, 'HTTP 404');
    // And neither statement covers both boards.
    for (const s of updates(statements)) {
      assert.ok(
        !((s.tokens ?? []).includes('ppg') && (s.tokens ?? []).includes('trails')),
        'a statement may not span two different reasons',
      );
    }
  }
});

test('two boards dying for different reasons are written separately', async () => {
  // Both down the counted path, both on the same strike, different causes. This
  // is the combination the old code could not express: one statement, one text,
  // and whichever board sorted first decided what the other one said.
  const { client, statements } = fakeClient(
    registry(['trails', 4, 'greenhouse'], ['lifen', 4, 'greenhouse']),
  );
  const res = await recordCrawlOutcomes(
    [
      { provider: 'greenhouse', token: 'trails', ok: false, jobs: 0, error: 'greenhouse/trails: HTTP 404', failure: 'gone' },
      { provider: 'greenhouse', token: 'lifen', ok: false, jobs: 0, error: 'greenhouse/lifen: HTTP 410', failure: 'gone' },
    ],
    MAX,
    { client, mayRetire: true },
  );

  assert.equal(patchFor(statements, 'trails')?.last_error, 'HTTP 404');
  assert.equal(patchFor(statements, 'lifen')?.last_error, 'HTTP 410');
  assert.equal(res.deactivated, 2, 'both genuinely gone, both retired');
  for (const s of updates(statements)) {
    assert.ok(
      !((s.tokens ?? []).includes('trails') && (s.tokens ?? []).includes('lifen')),
      'and never in one statement',
    );
  }
});

test('a file-only board is never inserted by a failure', async () => {
  const { client, statements } = fakeClient(registry(['known', 4]));
  await recordCrawlOutcomes([gone('unregistered')], MAX, { client, mayRetire: true });
  assert.equal(updates(statements).length, 0, 'read, then nothing written');
});

test('an empty run does not touch the database at all', async () => {
  const { client, statements } = fakeClient([]);
  const res = await recordCrawlOutcomes([], MAX, { client, mayRetire: true });
  assert.equal(statements.length, 0);
  assert.deepEqual(res, { recorded: 0, deactivated: 0, spared: 0, looksGone: 0 });
});

// ---------------------------------------------------------------------------
// The failure that actually killed the 44
// ---------------------------------------------------------------------------

test('a Workday challenge page where JSON belongs is a refusal, not a death', async () => {
  // This is the exact shape that retired 44 live companies. Workday does not
  // refuse with a status code — it answers 200 and serves an HTML challenge, so
  // the parse fails with:
  //
  //   Unexpected token '<', "<!DOCTYPE "... is not valid JSON
  //
  // Before the refusal/death split existed, `ok: false` covered everything and
  // five of those retired a board. The split gave AtsFetchError a default of
  // 'refused' for anything without a status, which covers this — asserted here
  // rather than assumed, because the assumption is what cost the 44.
  const html = '<!DOCTYPE html><html><head><title>Just a moment…</title></head></html>';
  const err = await workdayAdapter
    .fetchJobs(
      { provider: 'workday', token: 'ppg', extra: { host: 'ppg.wd5.myworkdayjobs.com', site: 'ppg_careers' } },
      {
        userAgent: 'test',
        timeoutMs: 5000,
        fetchImpl: async () =>
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
    )
    .then(
      () => null,
      (e: unknown) => e,
    );

  assert.ok(err instanceof AtsFetchError, 'it arrives as a fetch error');
  assert.match(err.message, /is not valid JSON/);
  assert.equal(err.failure, 'refused', 'and a refusal is not a death');
  assert.equal(err.status, undefined, 'there was no status to read — that is the whole problem');
});

const kindFor = async (board: { provider: string; token: string; extra?: Record<string, string> }, status: number) => {
  try {
    await getAdapter(board.provider as never).fetchJobs(board as never, {
      userAgent: 'test',
      timeoutMs: 5000,
      fetchImpl: async () => new Response('x', { status }),
    });
    return 'no throw';
  } catch (e) {
    return e instanceof AtsFetchError ? e.failure : 'not a fetch error';
  }
};

test('the split still works in the other direction — a 404 is a death', async () => {
  // Guards the half of the rule that is not about safety. If every status
  // became a refusal, nothing could ever be retired and genuinely dead tokens
  // would be crawled forever.
  for (const board of [
    { provider: 'greenhouse', token: 't' },
    { provider: 'lever', token: 't' },
    { provider: 'ashby', token: 't' },
    { provider: 'smartrecruiters', token: 't' },
    { provider: 'recruitee', token: 't' },
    { provider: 'teamtailor', token: 't' },
    { provider: 'bamboohr', token: 't' },
    { provider: 'personio', token: 't' },
    { provider: 'workable', token: 't' },
    { provider: 'rippling', token: 't' },
    { provider: 'ukg', token: 't', extra: { host: 'recruiting.ultipro.com', board: 'b' } },
  ]) {
    assert.equal(await kindFor(board, 404), 'gone', `${board.provider} 404`);
    assert.equal(await kindFor(board, 410), 'gone', `${board.provider} 410`);
  }
});

test('WORKDAY CANNOT REPORT A DEATH AT ALL — and that is a bug, recorded here', async () => {
  // Every other adapter reaches AtsFetchError through http.ts `handleStatus`,
  // which calls failureKindFor(status). Workday builds its own error and omits
  // the kind, so the constructor default — 'refused' — applies to every status
  // including 404 and 410.
  //
  // The consequence, measured 8 Sep 2026: since the refusal/death split landed
  // in 7f354dd, NO Workday board could be retired by the crawl at all. It is the
  // largest provider in the corpus, 3,264 active boards and nearly half the
  // jobs. Every board the crawl has re-retired since carries ashby or greenhouse
  // in its token, never workday, which is the same fact seen from the logs.
  //
  // It errs toward keeping a live board, so it is not urgent and is deliberately
  // NOT fixed here — fixing it would make retirement more aggressive, which is
  // the opposite of what this change is for. Asserted so the day someone routes
  // Workday through handleStatus, this test tells them what else moves.
  const wd = { provider: 'workday', token: 't', extra: { host: 'h.wd1.myworkdayjobs.com', site: 's' } };
  assert.equal(await kindFor(wd, 404), 'refused', 'a Workday 404 reads as a refusal');
  assert.equal(await kindFor(wd, 410), 'refused', 'and so does a 410');
});

// ---------------------------------------------------------------------------
// The wiring — a correct rule reached by nobody is not a fix
// ---------------------------------------------------------------------------

test('the hourly crawl asks for no power to retire', () => {
  const src = read('../src/cli/crawl-db.ts');
  assert.match(src, /mayRetire:\s*false/, 'crawl-db must pass mayRetire: false');
  assert.doesNotMatch(src, /mayRetire:\s*true/);
});

test('the verification pass is the one that asks for it', () => {
  const src = read('../src/cli/boards-verify.ts');
  assert.match(src, /mayRetire:\s*true/);
});

test('nothing else in the codebase can retire a board through this door', () => {
  // If a third caller appears, it inherits mayRetire: false by default — but it
  // should be a deliberate decision, so this fails loudly and makes someone
  // read the rule.
  const callers = ['../src/cli/crawl-db.ts', '../src/cli/boards-verify.ts'];
  for (const f of callers) assert.match(read(f), /recordCrawlOutcomes/);

  const store = read('../src/corpus/board-store.ts');
  assert.match(store, /mayRetire = false/, 'the default must stay false');
});
