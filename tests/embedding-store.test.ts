import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readStoredHashes, writeEmbeddings, type MatchClient } from '../src/matching/store.js';
import { EMBED_DIMENSIONS } from '../src/matching/embed.js';

/**
 * Moving vectors in and out, against a fake PostgREST.
 *
 * Two things here are easy to get wrong and neither shows up as an error.
 *
 * Job keys travel in the URL — `greenhouse:acme:8161813` is about 30 characters
 * and a batch of them becomes `in.(...)` in a query string. db-feed.ts already
 * settled on 150 per statement for this; exceeding it gets a request rejected for
 * length, which looks like a database fault rather than a batching mistake.
 *
 * And a vector is not a JSON array. halfvec refuses one. It has to be the
 * bracketed literal pgvector parses.
 */

const vec = (fill = 0.1) => Array.from({ length: EMBED_DIMENSIONS }, () => fill);

/** A fake PostgREST that records every statement. */
function fakeClient(
  rows: { job_key: string; source_hash: string; model: string }[] = [],
  opts: { failRead?: boolean; failWriteAfter?: number } = {},
) {
  const reads: string[][] = [];
  const writes: Record<string, unknown>[][] = [];
  const conflicts: string[] = [];

  const client: MatchClient = {
    from: () => ({
      select: () => ({
        in: async (_col: string, values: string[]) => {
          reads.push(values);
          if (opts.failRead) return { data: null, error: { message: 'statement timeout' } };
          return { data: rows.filter((r) => values.includes(r.job_key)), error: null };
        },
      }),
      upsert: async (payload: Record<string, unknown>[], options: { onConflict: string }) => {
        writes.push(payload);
        conflicts.push(options.onConflict);
        if (opts.failWriteAfter !== undefined && writes.length > opts.failWriteAfter) {
          return { error: { message: 'statement timeout' }, count: null };
        }
        return { error: null, count: payload.length };
      },
    }),
  };
  return { client, reads, writes, conflicts };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('a stored hash and model come back keyed by job', async () => {
  const { client } = fakeClient([
    { job_key: 'a', source_hash: 'h1', model: 'bge-small' },
    { job_key: 'b', source_hash: 'h2', model: 'bge-small' },
  ]);
  const got = await readStoredHashes(['a', 'b'], { client });
  assert.equal(got.size, 2);
  assert.deepEqual(got.get('a'), { hash: 'h1', model: 'bge-small' });
});

test('A MISSING KEY IS "NEVER EMBEDDED", NOT AN ERROR', async () => {
  // On the first run every key is missing. That is the normal case.
  const { client } = fakeClient([]);
  const got = await readStoredHashes(['a', 'b', 'c'], { client });
  assert.equal(got.size, 0);
});

test('asking about nothing reads nothing', async () => {
  const { client, reads } = fakeClient([]);
  assert.equal((await readStoredHashes([], { client })).size, 0);
  assert.equal(reads.length, 0, 'no statement at all');
});

test('KEYS ARE CHUNKED, BECAUSE THEY TRAVEL IN THE URL', async () => {
  const keys = Array.from({ length: 370 }, (_, i) => `greenhouse:acme:${i}`);
  const { client, reads } = fakeClient([]);
  await readStoredHashes(keys, { client });

  assert.equal(reads.length, 3, '370 keys at 150 a statement');
  for (const r of reads) assert.ok(r.length <= 150, `chunk of ${r.length}`);
  // And nothing is lost between the chunks.
  assert.deepEqual(reads.flat().sort(), [...keys].sort());
});

test('a failed read returns what it has rather than failing the crawl', async () => {
  // Losing a chunk means some jobs look unembedded and get embedded again:
  // wasteful, and the cheapest wrong answer. Throwing would fail a crawl that
  // has already written its postings correctly.
  const { client } = fakeClient([{ job_key: 'a', source_hash: 'h1', model: 'm' }], { failRead: true });
  const got = await readStoredHashes(['a'], { client });
  assert.equal(got.size, 0, 'empty, not thrown');
});

test('one failed chunk does not lose the others', async () => {
  const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
  let call = 0;
  const client: MatchClient = {
    from: () => ({
      select: () => ({
        in: async (_c: string, values: string[]) => {
          call++;
          if (call === 1) return { data: null, error: { message: 'statement timeout' } };
          return { data: values.map((k) => ({ job_key: k, source_hash: 'h', model: 'm' })), error: null };
        },
      }),
      upsert: async () => ({ error: null, count: 0 }),
    }),
  };
  const got = await readStoredHashes(keys, { client });
  assert.equal(got.size, 50, 'the second chunk of 50 survived the first chunk failing');
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test('A VECTOR IS WRITTEN AS A PGVECTOR LITERAL, NOT A JSON ARRAY', async () => {
  // halfvec refuses a JSON array. This is the line that would fail in
  // production and nowhere else.
  const { client, writes } = fakeClient();
  await writeEmbeddings(
    [{ jobKey: 'a', vector: [1, 2.5, -0.25], model: 'bge-small', sourceHash: 'h1' }],
    { client },
  );
  const row = writes[0]![0]!;
  assert.equal(typeof row.embedding, 'string', 'a string, not an array');
  assert.equal(row.embedding, '[1,2.5,-0.25]');
  assert.equal(row.job_key, 'a');
  assert.equal(row.source_hash, 'h1');
  assert.equal(row.model, 'bge-small');
});

test('a 384-dimension vector survives the round trip to a literal', async () => {
  const { client, writes } = fakeClient();
  await writeEmbeddings([{ jobKey: 'a', vector: vec(0.5), model: 'm', sourceHash: 'h' }], { client });
  const literal = String(writes[0]![0]!.embedding);
  assert.equal(literal.slice(1, -1).split(',').length, EMBED_DIMENSIONS);
});

test('IT UPSERTS, SO A RE-EMBED REPLACES RATHER THAN FAILING', async () => {
  // A changed advert or a new model has to overwrite. An insert would fail on
  // the primary key and the job would keep its stale vector for ever.
  const { client, conflicts } = fakeClient();
  await writeEmbeddings([{ jobKey: 'a', vector: vec(), model: 'm', sourceHash: 'h' }], { client });
  assert.deepEqual(conflicts, ['job_key']);
});

test('writes are chunked and nothing is dropped between chunks', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    jobKey: `k${i}`, vector: vec(), model: 'm', sourceHash: `h${i}`,
  }));
  const { client, writes } = fakeClient();
  const written = await writeEmbeddings(rows, { client });

  assert.equal(writes.length, 3, '250 rows at 100 a statement');
  assert.equal(written, 250);
  assert.deepEqual(
    writes.flat().map((r) => r.job_key).sort(),
    rows.map((r) => r.jobKey).sort(),
  );
});

test('writing nothing issues no statement', async () => {
  const { client, writes } = fakeClient();
  assert.equal(await writeEmbeddings([], { client }), 0);
  assert.equal(writes.length, 0);
});

test('THE DATABASE\'S COUNT IS BELIEVED OVER THE PAYLOAD SIZE', async () => {
  // Found by mutation testing: replacing `count ?? chunk.length` with
  // `chunk.length` passed every test, because the fake always returned a count
  // equal to the payload. If PostgREST ever reports writing fewer rows than
  // were sent, reporting the payload size instead would claim a success that
  // did not happen — and the crawl log is the only place anyone checks.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    jobKey: `k${i}`, vector: vec(), model: 'm', sourceHash: 'h',
  }));
  const client: MatchClient = {
    from: () => ({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
      // Sent 10, wrote 7.
      upsert: async () => ({ error: null, count: 7 }),
    }),
  };
  assert.equal(await writeEmbeddings(rows, { client }), 7, 'must report 7, not 10');
});

test('no count from the database means the whole chunk landed', async () => {
  // PostgREST only counts when asked, and this call does not ask — counting
  // costs a second pass to learn a number already known. A chunk with no error
  // wrote all of it.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    jobKey: `k${i}`, vector: vec(), model: 'm', sourceHash: 'h',
  }));
  const client: MatchClient = {
    from: () => ({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
      upsert: async () => ({ error: null, count: null }),
    }),
  };
  assert.equal(await writeEmbeddings(rows, { client }), 10);
});

test('a failed write chunk is skipped, and the count reflects what landed', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    jobKey: `k${i}`, vector: vec(), model: 'm', sourceHash: 'h',
  }));
  // The first chunk succeeds, everything after it fails.
  const { client } = fakeClient([], { failWriteAfter: 1 });
  const written = await writeEmbeddings(rows, { client });
  assert.equal(written, 100, 'reports 100, not 250');
  assert.ok(written < rows.length, 'and does not claim success it did not have');
});
