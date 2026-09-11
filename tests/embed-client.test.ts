import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMBED_DIMENSIONS,
  EMBED_MODEL,
  EmbedError,
  embedBatch,
  isPermissionError,
  toVectorLiteral,
} from '../src/matching/embed.js';

/**
 * The call to Workers AI, and the one failure that would be invisible.
 *
 * A request carries many texts and the answer is an array of vectors. NOTHING in
 * the response says which vector belongs to which text — the pairing is position
 * and position alone. So a short answer does not mean "some jobs missed out": it
 * means every vector after the gap is attached to the wrong job. The jobs still
 * get scores, the scores are still plausible numbers, and the matching is quietly
 * nonsense.
 *
 * That is the failure these tests are mostly about. Everything else here is
 * ordinary error handling.
 */

const noWait = async () => {};
const vec = (fill = 0.1) => Array.from({ length: EMBED_DIMENSIONS }, () => fill);

/** A fake Workers AI that answers from a script, one entry per call. */
function fakeAi(script: ({ status: number; body?: unknown; throws?: string })[]) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const step = script[calls.length] ?? { status: 500, body: { success: false } };
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? 'null')),
      auth: new Headers(init?.headers).get('authorization'),
    });
    if (step.throws) throw new Error(step.throws);
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (n: number) => ({
  status: 200,
  body: { success: true, result: { shape: [n, EMBED_DIMENSIONS], data: Array.from({ length: n }, () => vec()) } },
});

const opts = (fetchImpl: typeof fetch) => ({
  accountId: '4644a615fbb1db53c325e9d45abfcd7e',
  token: 'test-token',
  fetchImpl,
  wait: noWait,
});

// ---------------------------------------------------------------------------
// The happy path, and that the request is shaped right
// ---------------------------------------------------------------------------

test('a batch comes back as one vector per text, in order', async () => {
  const { fetchImpl, calls } = fakeAi([ok(3)]);
  const out = await embedBatch(['a', 'b', 'c'], opts(fetchImpl));
  assert.equal(out.length, 3);
  assert.equal(out[0]?.length, EMBED_DIMENSIONS);
  assert.equal(calls.length, 1, 'one request for the whole batch');
});

test('the request goes to the right account, model and header', async () => {
  const { fetchImpl, calls } = fakeAi([ok(1)]);
  await embedBatch(['hello'], opts(fetchImpl));
  const call = calls[0]!;
  assert.ok(call.url.includes('/accounts/4644a615fbb1db53c325e9d45abfcd7e/ai/run/'), call.url);
  assert.ok(call.url.endsWith(EMBED_MODEL), call.url);
  assert.equal(call.auth, 'Bearer test-token');
  assert.deepEqual(call.body, { text: ['hello'] });
});

test('an empty batch costs nothing and calls nothing', async () => {
  const { fetchImpl, calls } = fakeAi([]);
  assert.deepEqual(await embedBatch([], opts(fetchImpl)), []);
  assert.equal(calls.length, 0, 'no request, so no Neurons');
});

// ---------------------------------------------------------------------------
// The invisible failure
// ---------------------------------------------------------------------------

test('A SHORT ANSWER IS REFUSED, NOT PAIRED BY INDEX', async () => {
  // Two vectors for three texts. Pairing by position would give job 3 nothing
  // and is the benign reading; the dangerous one is a caller that zips the two
  // arrays and attaches vector 2 to job 3. Either way this cannot be used.
  const { fetchImpl } = fakeAi([ok(2)]);
  await assert.rejects(
    embedBatch(['a', 'b', 'c'], opts(fetchImpl)),
    (e: unknown) => {
      assert.ok(e instanceof EmbedError);
      assert.match(e.message, /returned 2 vectors for 3 texts/);
      assert.match(e.message, /positional/);
      return true;
    },
  );
});

test('a LONG answer is refused too', async () => {
  // Four vectors for three texts is just as unusable, and is the case a
  // length check written as `< texts.length` would wave through.
  const { fetchImpl } = fakeAi([ok(4)]);
  await assert.rejects(embedBatch(['a', 'b', 'c'], opts(fetchImpl)), /4 vectors for 3 texts/);
});

test('A VECTOR OF THE WRONG SIZE IS REFUSED', async () => {
  // A different model, or a truncated response. Storing it would fail at the
  // database anyway — the column is halfvec(384) — but failing here names the
  // cause instead of surfacing a type error three layers away.
  const { fetchImpl } = fakeAi([
    { status: 200, body: { success: true, result: { data: [vec(), [1, 2, 3]] } } },
  ]);
  await assert.rejects(
    embedBatch(['a', 'b'], opts(fetchImpl)),
    /vector 1 has 3 dimensions, expected 384/,
  );
});

test('a non-array in the vector list is refused', async () => {
  const { fetchImpl } = fakeAi([
    { status: 200, body: { success: true, result: { data: [vec(), null] } } },
  ]);
  await assert.rejects(embedBatch(['a', 'b'], opts(fetchImpl)), /vector 1 has no dimensions/);
});

test('no vectors at all is refused rather than returning empty', async () => {
  // Returning [] here would look like "nothing needed embedding" to a caller
  // and the corpus would silently never fill.
  const { fetchImpl } = fakeAi([{ status: 200, body: { success: true, result: {} } }]);
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), /returned no vectors/);
});

// ---------------------------------------------------------------------------
// Errors that need a person
// ---------------------------------------------------------------------------

test('A WRONG-PERMISSION TOKEN SAYS SO, AND SAYS WHICH PERMISSION', async () => {
  // The expected first failure: the only Cloudflare token this project has was
  // made to deploy a Worker, and deploy tokens do not carry Workers AI access.
  const { fetchImpl, calls } = fakeAi([{ status: 403, body: { success: false } }]);
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), (e: unknown) => {
    assert.ok(e instanceof EmbedError);
    assert.equal(e.permanent, true, 'no amount of retrying fixes a permission');
    assert.match(e.message, /Workers AI: Read/);
    return true;
  });
  assert.equal(calls.length, 1, 'and it does not retry');
});

test('401 is treated the same as 403', async () => {
  const { fetchImpl, calls } = fakeAi([{ status: 401, body: {} }]);
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), /Workers AI: Read/);
  assert.equal(calls.length, 1);
  assert.equal(isPermissionError(401), true);
  assert.equal(isPermissionError(403), true);
  assert.equal(isPermissionError(429), false);
});

test('a 400 is permanent and not retried', async () => {
  const { fetchImpl, calls } = fakeAi([{ status: 400, body: { errors: [{ message: 'bad model' }] } }]);
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), (e: unknown) => {
    assert.ok(e instanceof EmbedError && e.permanent);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('success:false in a 200 is still a failure', async () => {
  // Cloudflare answers 200 with success:false. Reading only the status code
  // would store whatever `data` happened to contain.
  const { fetchImpl } = fakeAi([
    { status: 200, body: { success: false, errors: [{ code: 3001, message: 'no such model' }] } },
  ]);
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), /reported failure: no such model/);
});

test('a 200 that is not JSON is a failure, not an empty result', async () => {
  const fetchImpl = (async () => new Response('<html>502</html>', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), /not JSON/);
});

// ---------------------------------------------------------------------------
// Errors worth waiting out
// ---------------------------------------------------------------------------

test('a 5xx is retried and can succeed', async () => {
  const { fetchImpl, calls } = fakeAi([{ status: 503, body: {} }, ok(1)]);
  const out = await embedBatch(['a'], opts(fetchImpl));
  assert.equal(out.length, 1);
  assert.equal(calls.length, 2);
});

test('a dropped connection is retried', async () => {
  const { fetchImpl, calls } = fakeAi([{ status: 0, throws: 'fetch failed' }, ok(1)]);
  assert.equal((await embedBatch(['a'], opts(fetchImpl))).length, 1);
  assert.equal(calls.length, 2);
});

test('retries are bounded, and the last error is reported', async () => {
  const { fetchImpl, calls } = fakeAi([
    { status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} },
  ]);
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), /unreachable after 3 attempts/);
  assert.equal(calls.length, 3);
});

test('429 STOPS THE RUN RATHER THAN HAMMERING', async () => {
  // 429 here is usually the daily free allowance, which does not clear within a
  // run. Retrying wastes time and the caller needs to know to stop sending.
  const { fetchImpl, calls } = fakeAi([{ status: 429, body: {} }]);
  await assert.rejects(embedBatch(['a'], opts(fetchImpl)), (e: unknown) => {
    assert.ok(e instanceof EmbedError);
    assert.equal(e.status, 429);
    assert.equal(e.permanent, false, 'tomorrow it will work, so it is not permanent');
    assert.match(e.message, /daily allowance/);
    return true;
  });
  assert.equal(calls.length, 1, 'not retried within the run');
});

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

test('a vector becomes the literal pgvector accepts', () => {
  assert.equal(toVectorLiteral([1, 2.5, -0.25]), '[1,2.5,-0.25]');
  assert.equal(toVectorLiteral([]), '[]');
  // No spaces: halfvec parses either, but the corpus is 65,818 rows and a space
  // per dimension is 25 MB of nothing.
  assert.doesNotMatch(toVectorLiteral(vec()), / /);
});

test('a real-sized vector round-trips to a literal of the right shape', () => {
  const literal = toVectorLiteral(vec(0.5));
  assert.ok(literal.startsWith('[') && literal.endsWith(']'));
  assert.equal(literal.slice(1, -1).split(',').length, EMBED_DIMENSIONS);
});
