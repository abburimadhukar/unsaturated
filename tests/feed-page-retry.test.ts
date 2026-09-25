import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { queryFeedFromDb } from '../src/corpus/db-query.js';

/**
 * The feed page, when the database says no.
 *
 * Measured 17 Sep 2026: 44 feed_page calls in 24 hours cancelled by anon's
 * 3-second statement timeout, clustered on crawl hours. Each one reached a
 * visitor as a 503, "job data is temporarily unavailable". The facets beside it
 * already retried once and were cancelled only 3 times in the same window.
 */

const noWait = async () => {};

function fakeRpc(script: ({ data: unknown; error: { message: string } | null })[]) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc: async (name: string, params: Record<string, unknown>) => {
        calls.push({ name, params });
        return script[calls.length - 1] ?? { data: null, error: { message: 'script exhausted' } };
      },
    },
  };
}

const page = { total: 1, undated: 0, rows: [] };
const timeout = { data: null, error: { message: 'canceling statement due to statement timeout' } };

test('a clean call asks once, for feed_page, with the paging it was given', async () => {
  const { client, calls } = fakeRpc([{ data: page, error: null }]);
  const out = await queryFeedFromDb({}, 100, 50, { client, wait: noWait });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'feed_page');
  assert.equal(calls[0]!.params.p_offset, 100);
  assert.equal(calls[0]!.params.p_limit, 50);
  assert.deepEqual(out, { total: 1, undated: 0, jobs: [] });
});

test('THE TIMEOUT THAT SENT VISITORS A 503 IS RETRIED, AND SUCCEEDS', async () => {
  const { client, calls } = fakeRpc([timeout, { data: page, error: null }]);
  const out = await queryFeedFromDb({}, 0, 50, { client, wait: noWait });
  assert.equal(calls.length, 2);
  // The cutoff is recomputed per call, so it moves by milliseconds; the
  // question is otherwise identical.
  const { p_cutoff: _a, ...first } = calls[0]!.params;
  const { p_cutoff: _b, ...second } = calls[1]!.params;
  assert.deepEqual(second, first, 'the same question, not a different one');
  assert.ok(out, 'a page, not the 503');
});

test('it retries ONCE, then gives up honestly', async () => {
  const { client, calls } = fakeRpc([timeout, timeout, { data: page, error: null }]);
  assert.equal(await queryFeedFromDb({}, 0, 50, { client, wait: noWait }), null);
  assert.equal(calls.length, 2);
});

test('a thrown network refusal is retried too', async () => {
  let n = 0;
  const client = {
    rpc: async () => {
      n++;
      if (n === 1) throw new Error('fetch failed');
      return { data: page, error: null };
    },
  };
  assert.ok(await queryFeedFromDb({}, 0, 50, { client, wait: noWait }));
  assert.equal(n, 2);
});

test('A REAL FAULT IS NOT RETRIED — it would be slower and still wrong', async () => {
  const { client, calls } = fakeRpc([
    { data: null, error: { message: 'function public.feed_page(p_cutoff => text) does not exist' } },
    { data: page, error: null },
  ]);
  assert.equal(await queryFeedFromDb({}, 0, 50, { client, wait: noWait }), null);
  assert.equal(calls.length, 1);
});

test('the pause before the retry is actually taken', async () => {
  const waits: number[] = [];
  const { client } = fakeRpc([timeout, { data: page, error: null }]);
  await queryFeedFromDb({}, 0, 50, { client, wait: async (ms) => void waits.push(ms) });
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! > 0);
});

test('the route asks for the page and the counts AT THE SAME TIME', () => {
  // One after the other, a visitor waited for the sum of both — ~0.55 s and
  // ~1 s on 17 Sep. Wired from the source, as the facet-header tests are.
  const route = readFileSync(new URL('../app/api/feed/route.ts', import.meta.url), 'utf8');
  // Since 25 Sep the default view asks feed_newest for its page instead, still
  // alongside the counts; every other view asks feed_page, alongside them.
  assert.match(
    route,
    /Promise\.all\(\[\s*fast \? queryNewestFromDb\(offset, limit\) : Promise\.resolve\(null\),\s*fast \? Promise\.resolve\(null\) : queryFeedFromDb\(query, offset, limit\),\s*facetsFromDb\(query\),\s*\]\)/,
  );
  assert.doesNotMatch(route, /await facetsFromDb\(/);
  // The one sequential feed_page call is the fallback when the fast road
  // fails — never the normal path.
  const sequential = route.match(/await queryFeedFromDb\(/g) ?? [];
  assert.equal(sequential.length, 1);
  assert.match(route, /typeof fastTotal === 'number'[\s\S]{0,160}: await queryFeedFromDb\(/);
});
