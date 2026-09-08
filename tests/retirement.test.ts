import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  boardKey,
  failureReason,
  groupByReason,
  planFailureWrites,
  recordCrawlOutcomes,
  type FailureWrite,
} from '../src/corpus/board-store.js';
import { isDeliberateRetirement, shouldRevive } from '../src/corpus/revival.js';
import type { VerifyResult } from '../src/discovery/verify.js';
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

/** Rows already in the registry: [token, strikes] or [token, strikes, site]. */
const at = (...rows: ([string, number] | [string, number, string])[]) =>
  new Map(rows.map(([token, n, site]) => [boardKey(token, site ?? ''), n]));
/** Boards that failed this run: 'token' or ['token', 'site']. */
const tokens = (...t: (string | [string, string])[]) =>
  t.map((x) => (typeof x === 'string' ? { token: x, site: '' } : { token: x[0], site: x[1] }));
const find = (plan: FailureWrite[], failures: number) =>
  plan.find((w) => w.failures === failures);

test('a first failure is a long way from retirement', () => {
  const plan = planFailureWrites(tokens('ppg'), at(['ppg', 0]), MAX);
  assert.deepEqual(plan, [{ failures: 1, reason: 'failed', site: '', tokens: ['ppg'], retire: false }]);
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

test('ONE FAILING CAREER SITE CANNOT TAKE ITS SIBLING DOWN', () => {
  // The bug this guards. A Workday token is a TENANT: Ochsner runs `Ochsner`
  // with 1,917 jobs and `ochsnerphysician` with 346, two rows sharing one token,
  // and 14 tenants are like this. The statement was scoped to provider + token,
  // so `active: false` for the small portal reached the big hospital board
  // beside it. Each site now gets its own statement and its own strike count.
  const plan = planFailureWrites(
    tokens(['ochsner', 'ochsnerphysician']),
    at(['ochsner', 4, 'ochsnerphysician'], ['ochsner', 0, 'Ochsner']),
    MAX,
  );
  assert.equal(plan.length, 1, 'only the site that failed is written');
  assert.equal(plan[0]?.site, 'ochsnerphysician');
  assert.equal(plan[0]?.retire, true, 'the portal reached five and goes');
  assert.deepEqual(plan[0]?.tokens, ['ochsner']);
});

test('two sites of one tenant get their own strike counts, not a shared one', () => {
  const plan = planFailureWrites(
    tokens(['nshe', 'GBC-external'], ['nshe', 'UNR-external']),
    at(['nshe', 0, 'GBC-external'], ['nshe', 4, 'UNR-external']),
    MAX,
  );
  assert.equal(plan.length, 2, 'two rows, two statements');
  assert.equal(plan.find((p) => p.site === 'GBC-external')?.failures, 1);
  assert.equal(plan.find((p) => p.site === 'GBC-external')?.retire, false);
  assert.equal(plan.find((p) => p.site === 'UNR-external')?.retire, true);
});

test('the SAME site arriving twice is still one strike', () => {
  // Deduplication is by row now, not by token — the same board reported twice in
  // one batch must not be counted twice.
  const plan = planFailureWrites(
    tokens(['ochsner', 'Ochsner'], ['ochsner', 'Ochsner']),
    at(['ochsner', 3, 'Ochsner']),
    MAX,
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.failures, 4);
  assert.deepEqual(plan[0]?.tokens, ['ochsner']);
});

test('providers with no site are unaffected — they all share the empty one', () => {
  const plan = planFailureWrites(tokens('a', 'b'), at(['a', 0], ['b', 0]), MAX);
  assert.equal(plan.length, 1, 'one statement covers both, as before');
  assert.equal(plan[0]?.site, '');
  assert.deepEqual(plan[0]?.tokens, ['a', 'b']);
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
  site?: string;
  tokens?: string[];
}

/**
 * Enough of supabase-js to record what would have been written.
 *
 * The chain is `.from(t).update(patch, opts).eq(col, v).in(col, arr)` and the
 * final link is awaited, so every link returns the same thenable recorder.
 */
function fakeClient(
  rows: { provider: string; token: string; site?: string; consecutive_failures: number; active?: boolean }[],
) {
  const statements: Statement[] = [];

  /** Rows this statement's filters actually select. */
  const matched = (st: Statement) =>
    rows.filter(
      (r) =>
        r.provider === st.provider &&
        (st.tokens ?? []).includes(r.token) &&
        // Only when the statement scoped itself. An unscoped one reaches every
        // site of the tenant, which is the behaviour these tests exist to pin.
        (st.site === undefined || (r.site ?? '') === st.site),
    );

  const builder = (st: Statement) => {
    const self = {
      eq(col: string, val: string) {
        if (col === 'provider') st.provider = val;
        if (col === 'site') st.site = val;
        return self;
      },
      in(_col: string, arr: string[]) {
        st.tokens = arr;
        return self;
      },
      then(resolve: (r: unknown) => void) {
        if (st.verb === 'select') {
          resolve({
            data: matched(st).map((r) => ({
              token: r.token,
              site: r.site ?? '',
              consecutive_failures: r.consecutive_failures,
            })),
            error: null,
          });
          return;
        }
        // The real count is the number of ROWS the filters hit, not the number
        // of tokens named — that difference is exactly the sibling bug.
        const hit = matched(st);
        for (const r of hit) Object.assign(r, st.patch);
        resolve({ error: null, count: hit.length });
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

  return { client: client as unknown as ReturnType<typeof dbWrite>, statements, rows };
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
const registry = (...pairs: ([string, number] | [string, number, string] | [string, number, string, string])[]) =>
  pairs.map(([token, consecutive_failures, provider, site]) => ({
    provider: provider ?? 'workday',
    token,
    site: site ?? '',
    consecutive_failures,
    active: true,
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

test('OCHSNER KEEPS ITS HOSPITAL BOARD WHEN THE PHYSICIANS PORTAL DIES', async () => {
  // End to end, against the fake database, on the only pass that can retire.
  // The rows are the real ones: token `ochsner`, sites `Ochsner` (1,917 jobs)
  // and `ochsnerphysician` (346). The portal is on its last strike; the hospital
  // board is healthy and must still be active when this returns.
  const { client, statements } = fakeClient(
    registry(['ochsner', 4, 'workday', 'ochsnerphysician'], ['ochsner', 0, 'workday', 'Ochsner']),
  );
  const res = await recordCrawlOutcomes(
    [
      { provider: 'workday', token: 'ochsner', site: 'ochsnerphysician', ok: false, jobs: 0, error: 'workday/ochsner: HTTP 404', failure: 'gone' },
    ],
    MAX,
    { client, mayRetire: true },
  );

  assert.equal(res.deactivated, 1, 'exactly one row retired, not two');
  const retired = retiring(statements);
  assert.equal(retired.length, 1);
  assert.equal(retired[0]?.site, 'ochsnerphysician', 'and the statement named the site');
});

test('the healthy sibling is still active in the rows themselves afterwards', async () => {
  // Asserted on the final state of the fake table rather than on the statements
  // issued, because the statements are what a reviewer reads and the rows are
  // what a company loses.
  const { client, rows } = fakeClient(
    registry(['ochsner', 4, 'workday', 'ochsnerphysician'], ['ochsner', 0, 'workday', 'Ochsner']),
  );
  await recordCrawlOutcomes(
    [
      { provider: 'workday', token: 'ochsner', site: 'ochsnerphysician', ok: false, jobs: 0, error: 'workday/ochsner: HTTP 404', failure: 'gone' },
    ],
    MAX,
    { client, mayRetire: true },
  );

  const hospital = rows.find((r) => r.site === 'Ochsner');
  const portal = rows.find((r) => r.site === 'ochsnerphysician');
  assert.equal(hospital?.active, true, 'the 1,917-job board is untouched');
  assert.equal(hospital?.consecutive_failures, 0, 'and carries no strike it did not earn');
  assert.equal(portal?.active, false, 'while the portal that actually died is retired');
});

test('and the crawl cannot retire either of them, whatever it saw', async () => {
  const { client, rows } = fakeClient(
    registry(['ochsner', 4, 'workday', 'ochsnerphysician'], ['ochsner', 0, 'workday', 'Ochsner']),
  );
  await recordCrawlOutcomes(
    [
      { provider: 'workday', token: 'ochsner', site: 'ochsnerphysician', ok: false, jobs: 0, error: 'workday/ochsner: HTTP 404', failure: 'gone' },
    ],
    MAX,
    { client },
  );
  assert.equal(rows.every((r) => r.active), true, 'both rows survive the hourly crawl');
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
// What comes back, and what must not
// ---------------------------------------------------------------------------

const verified = (over: Partial<VerifyResult>): VerifyResult => ({
  board: { provider: 'workday', token: 't', company: 'T' },
  verdict: 'live',
  jobs: 0,
  status: 200,
  parsed: true,
  ...over,
});

test('a board that answers with a readable payload comes back', () => {
  assert.equal(shouldRevive(verified({ jobs: 1118 })), true);
});

test('a live employer with nothing open right now still comes back', () => {
  // childrensplace and rangersmlb both answered 200 with total=0 on 8 Sep. They
  // are real companies between vacancies, not dead boards, and dropping them for
  // having an empty week is how a registry quietly shrinks.
  assert.equal(shouldRevive(verified({ jobs: 0 })), true);
});

test('TEAMTAILOR\'S OWN MARKETING PAGES STAY OFF, though they answer 200', () => {
  // teamtailor:app, :discover and :integrations are Teamtailor's own subdomains,
  // swept in from the URL index. They serve a landing page to /jobs.json — 200,
  // zero jobs, and identical to a real empty board unless the parse is checked.
  // A rule of "it answered" would resurrect all three to fail forever.
  assert.equal(shouldRevive(verified({ jobs: 0, parsed: false })), false);
  assert.equal(shouldRevive(verified({ jobs: 12, parsed: false })), false);
});

test('a board that did not answer is left exactly as it is', () => {
  assert.equal(shouldRevive(verified({ verdict: 'dead', status: 404, parsed: undefined })), false);
  assert.equal(shouldRevive(verified({ verdict: 'unknown', status: null, parsed: undefined })), false);
  // 'unknown' is a rate limit or a dropped connection. Not evidence either way,
  // so it changes nothing — the board stays retired and is asked again next run.
  assert.equal(shouldRevive(verified({ verdict: 'unknown', status: 429, parsed: undefined })), false);
});

test('a missing parse flag is never treated as a yes', () => {
  // An older VerifyResult, or a provider path that forgot to set it. The absent
  // answer must not be the permissive one.
  assert.equal(shouldRevive({ verdict: 'live' }), false);
});

test('a duplicate spelling is a decision, and is never reconsidered', () => {
  // All 330 of these point at a board that is still active, verified 8 Sep.
  // Reviving one means crawling the company twice and storing every posting
  // under two job keys — the exact bug boards-dedupe exists to prevent.
  assert.equal(isDeliberateRetirement('duplicate spelling of shiftkey'), true);
  assert.equal(isDeliberateRetirement('  duplicate spelling of goventi'), true);
  assert.equal(isDeliberateRetirement('Duplicate spelling of Cleric'), true);
});

test('an ordinary failure is not a decision', () => {
  assert.equal(isDeliberateRetirement("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"), false);
  assert.equal(isDeliberateRetirement('HTTP 404'), false);
  assert.equal(isDeliberateRetirement(null), false);
  assert.equal(isDeliberateRetirement(''), false);
  // Not a prefix match on the whole string: a message that merely mentions it.
  assert.equal(isDeliberateRetirement('HTTP 500 — duplicate spelling of x'), false);
});

test('the blocklist is consulted, and the aggregators answer 200', () => {
  // lever:jobgether answers with 4,534 jobs. Answering is not the question —
  // somebody removed it on purpose because it republishes other people's
  // postings. shouldRevive alone would bring it straight back, so the caller
  // must filter first; this pins that the filter exists.
  const src = read('../src/cli/boards-revive.ts');
  assert.match(src, /loadBlocklist/);
  assert.match(src, /blocked\.has\(blockKey\(b\.provider, b\.token\)\)/);
  assert.match(src, /isDeliberateRetirement/);
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
