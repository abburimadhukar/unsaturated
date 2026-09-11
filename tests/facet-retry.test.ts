import { test } from 'node:test';
import assert from 'node:assert/strict';

import { facetsFromDb } from '../src/corpus/db-query.js';

/**
 * The sidebar counts, when the database says no.
 *
 * Measured 11 Sep 2026, 25 sequential calls against production: 24 answered and
 * one returned `canceling statement due to statement timeout`. 4%, on a query
 * that runs ~1.1s at the median against anon's 3-second statement timeout.
 *
 * The consequence is not a missing sidebar. facetsFromDb returns null for every
 * failure, and app/api/feed/route.ts substitutes EMPTY facets for a null — so
 * one in twenty-five page loads renders every filter count as zero and the total
 * as 0, with the jobs listed beside it. An invented number, which this project
 * forbids, and indistinguishable from an empty corpus.
 *
 * These tests pin the retry that narrows that window, and — more importantly —
 * pin what must NOT be retried.
 */

const noWait = async () => {};

/** A fake PostgREST that answers from a script, one entry per call. */
function fakeRpc(script: ({ data: unknown; error: { message: string } | null })[]) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    client: {
      rpc: async (_name: string, params: Record<string, unknown>) => {
        calls.push(params);
        return script[calls.length - 1] ?? { data: null, error: { message: 'script exhausted' } };
      },
    },
  };
}

const facets = { family: { software: 11730 }, specialization: {}, inScope: 1, scanned: 2 };

test('a clean call asks once and returns the counts', async () => {
  const { client, calls } = fakeRpc([{ data: facets, error: null }]);
  const out = await facetsFromDb({}, { client, wait: noWait });
  assert.equal(calls.length, 1);
  assert.deepEqual(out, facets as never);
});

test('THE REFUSAL THAT ZEROED THE SIDEBAR IS RETRIED, AND SUCCEEDS', async () => {
  // Verbatim from production, 11 Sep.
  const { client, calls } = fakeRpc([
    { data: null, error: { message: 'canceling statement due to statement timeout' } },
    { data: facets, error: null },
  ]);
  const out = await facetsFromDb({}, { client, wait: noWait });
  assert.equal(calls.length, 2, 'asked again');
  assert.deepEqual(out, facets as never, 'and the page gets real counts, not zeros');
});

test('a gateway refusal is retried too', async () => {
  const { client, calls } = fakeRpc([
    { data: null, error: { message: 'Gateway Timeout' } },
    { data: facets, error: null },
  ]);
  assert.deepEqual(await facetsFromDb({}, { client, wait: noWait }), facets as never);
  assert.equal(calls.length, 2);
});

test('it retries ONCE, not until it works', async () => {
  // A retry is a whole extra slow query on a path the page is waiting for. Two
  // refusals means the database is genuinely struggling, and a third ask makes
  // the page slower without making it likelier to answer.
  const refuse = { data: null, error: { message: 'canceling statement due to statement timeout' } };
  const { client, calls } = fakeRpc([refuse, refuse, { data: facets, error: null }]);
  const out = await facetsFromDb({}, { client, wait: noWait });
  assert.equal(calls.length, 2, 'exactly two attempts');
  assert.equal(out, null, 'and it gives up honestly rather than hammering');
});

test('A SCHEMA FAULT IS NOT RETRIED — it would be slower and still wrong', async () => {
  // The case the old probe in tests/live-db.ts used to confuse with a timeout.
  // A missing function or parameter will say the same thing every time, so a
  // retry buys nothing and hides how fast the real answer arrived.
  for (const message of [
    'Could not find the function public.feed_facets(p_specialization) in the schema cache',
    'function feed_facets(unknown) does not exist',
    'column "p_adjacent" does not exist',
    'permission denied for function feed_facets',
    'JWT expired',
  ]) {
    const { client, calls } = fakeRpc([{ data: null, error: { message } }]);
    const out = await facetsFromDb({}, { client, wait: noWait });
    assert.equal(out, null, message);
    assert.equal(calls.length, 1, `must not retry: ${message}`);
  }
});

test('a thrown transient error is retried, a thrown fault is not', async () => {
  let thrown = 0;
  const transient = {
    rpc: async () => {
      thrown++;
      if (thrown === 1) throw new Error('fetch failed');
      return { data: facets, error: null };
    },
  };
  assert.deepEqual(await facetsFromDb({}, { client: transient, wait: noWait }), facets as never);
  assert.equal(thrown, 2);

  let faults = 0;
  const fault = {
    rpc: async () => {
      faults++;
      throw new Error('relation "public.jobs" does not exist');
    },
  };
  assert.equal(await facetsFromDb({}, { client: fault, wait: noWait }), null);
  assert.equal(faults, 1, 'a real fault is not retried');
});

test('the retry sends the SAME query, not a different one', async () => {
  // A retry that quietly dropped a filter would answer with counts for a
  // different question, which is worse than no counts at all.
  const { client, calls } = fakeRpc([
    { data: null, error: { message: 'Gateway Timeout' } },
    { data: facets, error: null },
  ]);
  await facetsFromDb(
    { family: 'software', specialization: 'backend', country: 'US', hasSalary: true },
    { client, wait: noWait },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1], 'both asks are identical');
  assert.equal(calls[1]?.p_family, 'software');
  assert.equal(calls[1]?.p_specialization, 'backend');
  assert.equal(calls[1]?.p_country, 'US');
  assert.equal(calls[1]?.p_has_salary, true);
});

test('a null payload with no error stays null, unretried', async () => {
  // An empty answer is an answer. Retrying it would double the cost of every
  // genuinely empty result.
  const { client, calls } = fakeRpc([{ data: null, error: null }]);
  assert.equal(await facetsFromDb({}, { client, wait: noWait }), null);
  assert.equal(calls.length, 1);
});

test('the pause happens before the retry, and only then', async () => {
  const waits: number[] = [];
  const { client } = fakeRpc([
    { data: null, error: { message: 'Gateway Timeout' } },
    { data: facets, error: null },
  ]);
  await facetsFromDb({}, { client, wait: async (ms) => void waits.push(ms) });
  assert.equal(waits.length, 1, 'one pause, for the one retry');
  assert.ok(waits[0]! > 0 && waits[0]! < 1000, `a short pause, got ${waits[0]}ms`);

  const clean = fakeRpc([{ data: facets, error: null }]);
  const noPause: number[] = [];
  await facetsFromDb({}, { client: clean.client, wait: async (ms) => void noPause.push(ms) });
  assert.deepEqual(noPause, [], 'a clean call never waits');
});
