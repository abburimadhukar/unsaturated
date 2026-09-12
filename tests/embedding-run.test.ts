import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { embedNewJobs, type EmbeddableJob } from '../src/matching/run.js';
import { EMBED_DIMENSIONS } from '../src/matching/embed.js';
import type { MatchClient } from '../src/matching/store.js';

/**
 * Embedding as a step of a crawl — and the rule it must never break.
 *
 * By the time this runs, ~16,000 postings have already been written and the
 * run's real work is done. A job without a vector loses its match score until
 * the next of eleven daily runs. A thrown error loses every posting the crawl
 * collected. That trade is never worth making.
 *
 * So the question these tests keep asking is not "does it embed" but "what does
 * it do when something goes wrong", and the answer has to be the same every
 * time: report it, return, let the crawl finish.
 */

const noWait = async () => {};
const vec = () => Array.from({ length: EMBED_DIMENSIONS }, () => 0.1);

const job = (key: string, hash = `h-${key}`, provider = 'workday'): EmbeddableJob => ({
  key,
  provider,
  matchDigest: `digest for ${key}`,
  matchHash: hash,
});

/** A fake database that remembers what was written. */
function fakeDb(existing: { job_key: string; source_hash: string; model: string }[] = []) {
  const written: Record<string, unknown>[] = [];
  const client: MatchClient = {
    from: () => ({
      select: () => ({
        in: async (_c: string, values: string[]) => ({
          data: existing.filter((r) => values.includes(r.job_key)),
          error: null,
        }),
      }),
      upsert: async (rows: Record<string, unknown>[]) => {
        written.push(...rows);
        return { error: null, count: rows.length };
      },
    }),
  };
  return { client, written };
}

/** A fake Workers AI that answers correctly, and counts requests. */
function fakeAi() {
  const batches: number[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string[] };
    const n = body.text?.length ?? 0;
    batches.push(n);
    return new Response(
      JSON.stringify({ success: true, result: { data: Array.from({ length: n }, () => vec()) } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { batches, fetchImpl };
}

const creds = { accountId: 'acct', token: 'tok', wait: noWait };

// ---------------------------------------------------------------------------
// It works
// ---------------------------------------------------------------------------

test('new jobs are embedded and written', async () => {
  const { client, written } = fakeDb();
  const { fetchImpl } = fakeAi();
  const res = await embedNewJobs([job('a'), job('b')], { ...creds, client, fetchImpl });

  assert.equal(res.embedded, 2);
  assert.equal(written.length, 2);
  assert.equal(typeof written[0]!.embedding, 'string', 'stored as a pgvector literal');
  assert.equal(res.needsAttention, false);
});

test('already-embedded jobs cost nothing', async () => {
  const { client, written } = fakeDb([{ job_key: 'a', source_hash: 'h-a', model: '@cf/baai/bge-small-en-v1.5' }]);
  const { fetchImpl, batches } = fakeAi();
  const res = await embedNewJobs([job('a')], { ...creds, client, fetchImpl });

  assert.equal(res.embedded, 0);
  assert.equal(res.unchanged, 1);
  assert.equal(batches.length, 0, 'no request at all');
  assert.equal(written.length, 0);
});

test('the budget caps a run and the rest is reported as deferred', async () => {
  const { client } = fakeDb();
  const { fetchImpl } = fakeAi();
  const jobs = Array.from({ length: 30 }, (_, i) => job(`k${i}`));
  const res = await embedNewJobs(jobs, { ...creds, client, fetchImpl, budget: 10 });

  assert.equal(res.embedded, 10);
  assert.equal(res.deferred, 20);
  assert.match(res.note, /20 deferred to the next run/);
});

test('a large run is split into batches rather than one giant request', async () => {
  const { client } = fakeDb();
  const { fetchImpl, batches } = fakeAi();
  const jobs = Array.from({ length: 120 }, (_, i) => job(`k${i}`));
  const res = await embedNewJobs(jobs, { ...creds, client, fetchImpl, budget: 1_000 });

  assert.equal(res.embedded, 120);
  assert.ok(batches.length >= 3, `expected several batches, got ${batches.length}`);
  for (const n of batches) assert.ok(n <= 50, `batch of ${n}`);
  assert.equal(batches.reduce((a, b) => a + b, 0), 120, 'and every job was sent once');
});

// ---------------------------------------------------------------------------
// THE RULE: nothing here may fail the crawl
// ---------------------------------------------------------------------------

test('NO CREDENTIALS MEANS SKIP, NOT THROW', async () => {
  // A contributor's laptop has neither, and the crawl is the product.
  const { client } = fakeDb();
  const res = await embedNewJobs([job('a')], { client, accountId: undefined, token: undefined });
  assert.equal(res.embedded, 0);
  assert.match(res.note, /no CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(res.needsAttention, false, 'not configured is not the same as broken');
});

test('AN EMPTY AI TOKEN FALLS THROUGH TO THE DEPLOY TOKEN', async () => {
  // GitHub Actions sets a variable from a MISSING secret to the empty string,
  // not to nothing. `'' ?? next` is `''`, so a nullish chain stops there and
  // never reaches the token that is actually configured — the feature would
  // report "skipped" with a working token sitting beside it.
  const { client } = fakeDb();
  const { fetchImpl, batches } = fakeAi();
  const before = {
    ai: process.env.CLOUDFLARE_AI_TOKEN,
    api: process.env.CLOUDFLARE_API_TOKEN,
    acct: process.env.CLOUDFLARE_ACCOUNT_ID,
  };
  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
    process.env.CLOUDFLARE_AI_TOKEN = ''; // the missing secret
    process.env.CLOUDFLARE_API_TOKEN = 'deploy-token'; // the one that exists

    const res = await embedNewJobs([job('a')], { client, fetchImpl, wait: noWait });
    assert.equal(res.embedded, 1, 'the deploy token was used');
    assert.equal(batches.length, 1);
  } finally {
    if (before.ai === undefined) delete process.env.CLOUDFLARE_AI_TOKEN;
    else process.env.CLOUDFLARE_AI_TOKEN = before.ai;
    if (before.api === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = before.api;
    if (before.acct === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = before.acct;
  }
});

test('whitespace is not a credential either', async () => {
  const { client } = fakeDb();
  const res = await embedNewJobs([job('a')], { client, accountId: '  ', token: '  ' });
  assert.match(res.note, /no CLOUDFLARE_ACCOUNT_ID/);
});

test('A REFUSED TOKEN IS REPORTED, NOT THROWN, AND FLAGGED FOR A HUMAN', async () => {
  // The expected first failure: the only Cloudflare token here was made to
  // deploy a Worker, and deploy tokens carry no Workers AI access.
  const { client } = fakeDb();
  const fetchImpl = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
  const res = await embedNewJobs([job('a')], { ...creds, client, fetchImpl });

  assert.equal(res.embedded, 0);
  assert.equal(res.needsAttention, true, 'a person must change something');
  assert.match(res.note, /Workers AI: Read/);
});

test('a spent daily allowance stops the run without needing attention', async () => {
  // 429 clears tomorrow on its own, so it is not something to go and fix.
  const { client } = fakeDb();
  const fetchImpl = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
  const res = await embedNewJobs([job('a')], { ...creds, client, fetchImpl });

  assert.equal(res.needsAttention, false);
  assert.match(res.note, /daily allowance/);
});

test('A MID-RUN FAILURE KEEPS WHAT ALREADY LANDED', async () => {
  // The first batch succeeds, the second is refused. Those first vectors are
  // real and must not be discarded because of what happened after them.
  const { client, written } = fakeDb();
  let call = 0;
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    call++;
    const n = (JSON.parse(String(init?.body)) as { text: string[] }).text.length;
    if (call === 1) {
      return new Response(
        JSON.stringify({ success: true, result: { data: Array.from({ length: n }, () => vec()) } }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 403 });
  }) as unknown as typeof fetch;

  const jobs = Array.from({ length: 80 }, (_, i) => job(`k${i}`));
  const res = await embedNewJobs(jobs, { ...creds, client, fetchImpl, budget: 1_000 });

  assert.equal(res.embedded, 50, 'the first batch survived');
  assert.equal(written.length, 50);
  assert.equal(res.deferred, 30, 'and the rest is owed, not lost');
  assert.equal(res.needsAttention, true);
});

test('a mismatched vector count is reported, not stored', async () => {
  // The dangerous one. Two vectors for fifty texts cannot be paired, and
  // embedBatch refuses it — this asserts the refusal reaches the crawl as a
  // note rather than as an exception or, worse, as stored rows.
  const { client, written } = fakeDb();
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ success: true, result: { data: [vec(), vec()] } }), {
      status: 200,
    })) as unknown as typeof fetch;

  const jobs = Array.from({ length: 50 }, (_, i) => job(`k${i}`));
  const res = await embedNewJobs(jobs, { ...creds, client, fetchImpl });
  assert.equal(res.embedded, 0);
  assert.equal(written.length, 0, 'nothing stored from an unusable answer');
  assert.match(res.note, /2 vectors for 50 texts/);
});

test('a database that throws does not take the crawl with it', async () => {
  const client: MatchClient = {
    from: () => ({
      select: () => ({ in: async () => { throw new Error('connection reset'); } }),
      upsert: async () => ({ error: null, count: 0 }),
    }),
  };
  const { fetchImpl } = fakeAi();
  const res = await embedNewJobs([job('a')], { ...creds, client, fetchImpl });
  assert.match(res.note, /failed — connection reset/);
  assert.equal(res.embedded, 0);
});

test('a job with no digest is skipped silently', async () => {
  // Out of scope, or nothing to compose from. Not an error.
  const { client } = fakeDb();
  const { fetchImpl, batches } = fakeAi();
  const res = await embedNewJobs([{ key: 'a' }, { key: 'b', matchDigest: 'x' }], {
    ...creds, client, fetchImpl,
  });
  assert.equal(batches.length, 0, 'neither had both a digest and a hash');
  assert.match(res.note, /nothing in scope/);
});

test('an empty run says so rather than doing nothing quietly', async () => {
  const { client } = fakeDb();
  const res = await embedNewJobs([], { ...creds, client });
  assert.match(res.note, /nothing in scope/);
});

test('every return path carries a note for the crawl log', async () => {
  // The log line is the only way anyone sees this working or not working.
  const { client } = fakeDb();
  const { fetchImpl } = fakeAi();
  const cases = [
    await embedNewJobs([], { ...creds, client }),
    await embedNewJobs([job('a')], { client, accountId: undefined, token: undefined }),
    await embedNewJobs([job('a')], { ...creds, client, fetchImpl }),
  ];
  for (const r of cases) assert.ok(r.note.length > 0, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

test('THE CRAWL CALLS THIS AFTER THE POSTINGS ARE SAFELY WRITTEN', () => {
  // Order is the safety property. Before writeFeed, a surprise here would cost
  // the whole run's postings.
  const src = readFileSync(new URL('../src/cli/crawl-db.ts', import.meta.url), 'utf8');
  const write = src.indexOf('await writeFeed(');
  const embed = src.indexOf('embedNewJobs(');
  assert.ok(write > 0 && embed > 0, 'both calls must be present');
  assert.ok(write < embed, 'embedNewJobs must come after writeFeed');
});

test('the crawl embeds only in-scope jobs', () => {
  const src = readFileSync(new URL('../src/cli/crawl-db.ts', import.meta.url), 'utf8');
  assert.match(src, /embedNewJobs\(feed\.jobs\.filter\(\(j\) => j\.inScope\)\)/);
});

test('the digest is composed where the description still exists', () => {
  // live.ts, not crawl-db.ts. FeedJob carries no description — by the time the
  // crawler's caller sees a job, the body has been discarded.
  const live = readFileSync(new URL('../src/corpus/live.ts', import.meta.url), 'utf8');
  assert.match(live, /matchFields\(/, 'live.ts must compose the digest');
  assert.match(live, /digestFor\(/);

  const types = readFileSync(new URL('../src/corpus/types.ts', import.meta.url), 'utf8');
  assert.match(types, /matchDigest\?/, 'and FeedJob must carry it');
  assert.doesNotMatch(types, /descriptionText/, 'but never the description itself');
});

// ---------------------------------------------------------------------------
// The vendor the budget reaches
// ---------------------------------------------------------------------------

test('A TIGHT BUDGET STILL REACHES MORE THAN ONE VENDOR', async () => {
  // End to end, because the fair-share split is only worth anything if the
  // provider survives the trip from the crawl into the plan. plan.ts is tested
  // directly; this is the wiring, and the wiring is what was broken.
  //
  // The live failure, 12 September 2026: all 3,990 vectors in the database
  // belonged to Workday and the other thirteen vendors had none. The input order
  // here is the one the crawl produces — the big vendor first, because refreshFeed
  // sorts by saturation before handing the list over.
  const { client, written } = fakeDb();
  const { fetchImpl } = fakeAi();

  const jobs = [
    ...Array.from({ length: 500 }, (_, i) => job(`workday:${i}`, `h${i}`, 'workday')),
    ...Array.from({ length: 100 }, (_, i) => job(`greenhouse:${i}`, `g${i}`, 'greenhouse')),
  ];

  const res = await embedNewJobs(jobs, { ...creds, client, fetchImpl, budget: 60 });

  assert.equal(res.embedded, 60);
  const keys = written.map((r) => String(r.job_key));
  assert.ok(
    keys.some((k) => k.startsWith('greenhouse:')),
    'the smaller vendor got nothing again — the provider is not reaching the plan',
  );
  assert.ok(keys.some((k) => k.startsWith('workday:')), 'and the larger vendor still progresses');
  assert.match(res.note, /across 2 vendors/);
});

test('the crawl hands the provider over, not just the digest', () => {
  // A type-level guarantee in src/, but tests/ is outside tsconfig's include, so
  // a fake can omit the field and quietly pass. This reads the source instead.
  const run = readFileSync(new URL('../src/matching/run.ts', import.meta.url), 'utf8');
  assert.match(run, /provider: j\.provider/, 'run.ts must pass the provider into the plan');

  const plan = readFileSync(new URL('../src/matching/plan.ts', import.meta.url), 'utf8');
  assert.match(
    plan,
    /interleaveByProvider\(missing\)/,
    'and the plan must spread the budget across vendors',
  );
});
