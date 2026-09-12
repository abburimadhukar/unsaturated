import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_EDITS,
  MAX_GAPS,
  OPENAI_URL,
  TAILOR_MODEL,
  extractJson,
  parseAnswer,
  tailor,
} from '../src/tailor/run.js';

/**
 * The call, and the one thing it may never do.
 *
 * The single most important test in this file is the end-to-end one: a model that
 * returns a fabricated metric must not produce an accepted edit, no matter how
 * well-formed its answer is. edits.ts is tested directly elsewhere; what is tested
 * here is that tailor() cannot be made to SKIP it.
 *
 * Everything else is about a person waiting on a web request. A refused key, a
 * spent balance and a model having a moment all have to come back as a sentence
 * someone can act on, because a 500 tells them nothing.
 */

const RESUME = [
  'Senior Platform Engineer, Acme Corp, 2021 to present',
  'Managed cloud infrastructure for the platform team across AWS and Azure.',
  'Built CI/CD pipelines with Docker and Kubernetes, cutting deploy time to 12 minutes.',
  'Owned the Terraform estate and the Linux fleet.',
].join('\n');

const INPUT = {
  resumeText: RESUME,
  jobTitle: 'Senior Platform Engineer',
  jobDescription: 'Strong on Kubernetes, Terraform and multi-region AWS. Kafka a plus.',
  chips: ['mirror', 'lead'],
};

const noWait = async () => {};

/** An OpenAI that answers with whatever it is told to, and records the request. */
function fakeAi(content: string, status = 200) {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''),
    });
    if (status !== 200) return new Response(content, { status });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const answer = (edits: unknown[], gaps: string[] = []) => JSON.stringify({ edits, gaps });

const creds = { apiKey: 'sk-test', wait: noWait };

// ---------------------------------------------------------------------------
// The promise
// ---------------------------------------------------------------------------

test('A FABRICATED METRIC CANNOT REACH THE CALLER AS ACCEPTED', () => {
  // End to end. The model answers perfectly — valid JSON, correct schema, an
  // anchor copied exactly from the resume — and invents a number. That is the
  // whole threat, and tailor() must not be able to pass it through.
  return tailor(INPUT, {
    ...creds,
    ...fakeAi(
      answer([
        {
          original: 'Managed cloud infrastructure for the platform team across AWS and Azure.',
          replacement: 'Cut cloud infrastructure spend 40% across AWS and Azure.',
          reason: 'the posting wants cost reduction',
          section: 'experience',
        },
      ]),
    ),
  }).then((res) => {
    assert.equal(res.accepted, 0, 'an invented number was reported as verified');
    assert.equal(res.flagged, 1);
    assert.ok(res.edits[0]!.unverified.includes('40%'));
  });
});

test('every edit that comes out has been checked', () => {
  // The structural guarantee. There is no exported route to an unchecked edit, so
  // every element of `edits` must carry a verdict — a future refactor that
  // returned the model's own list would fail here.
  return tailor(INPUT, {
    ...creds,
    ...fakeAi(
      answer([
        { original: 'Owned the Terraform estate and the Linux fleet.', replacement: 'Owned Terraform and Linux.', reason: 'tighter', section: '' },
        { original: 'A line from another CV', replacement: 'Nonsense', reason: 'x', section: '' },
      ]),
    ),
  }).then((res) => {
    assert.equal(res.edits.length, 2);
    for (const e of res.edits) {
      assert.ok(['accepted', 'flagged', 'rejected'].includes(e.verdict), 'an edit arrived unchecked');
      assert.ok(e.note.length > 0, 'every verdict must come with words');
    }
  });
});

test('a clean rephrasing comes back accepted', () => {
  return tailor(INPUT, {
    ...creds,
    ...fakeAi(
      answer(
        [
          {
            original: 'Managed cloud infrastructure for the platform team across AWS and Azure.',
            replacement: 'Ran multi-region AWS and Azure infrastructure for the platform team.',
            reason: 'leads with the multi-region AWS the posting asks for',
            section: 'experience',
          },
        ],
        ['The posting mentions Kafka; your resume does not.'],
      ),
    ),
  }).then((res) => {
    assert.equal(res.accepted, 1, res.note);
    assert.deepEqual(res.gaps, ['The posting mentions Kafka; your resume does not.']);
    assert.match(res.note, /1 verified/);
    assert.equal(res.needsAttention, false);
  });
});

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

test('the request carries the rules, the model and the key', () => {
  const ai = fakeAi(answer([]));
  return tailor(INPUT, { ...creds, ...ai }).then(() => {
    assert.equal(ai.calls.length, 1);
    const call = ai.calls[0]!;
    assert.equal(call.url, OPENAI_URL);
    assert.equal(call.auth, 'Bearer sk-test');
    assert.equal(call.body.model, TAILOR_MODEL);
    const messages = call.body.messages as { role: string; content: string }[];
    assert.equal(messages[0]!.role, 'system');
    assert.match(messages[0]!.content, /NEVER INVENT/);
    assert.match(messages[1]!.content, /Senior Platform Engineer/);
    // The resume must be in the request, or there is nothing to tailor from.
    assert.ok(messages[1]!.content.includes('Owned the Terraform estate'));
  });
});

test('a structured answer is requested', () => {
  const ai = fakeAi(answer([]));
  return tailor(INPUT, { ...creds, ...ai }).then(() => {
    const fmt = ai.calls[0]!.body.response_format as { type?: string } | undefined;
    assert.equal(fmt?.type, 'json_schema');
  });
});

test('no token cap is sent', () => {
  // The parameter was renamed across model generations and an unsupported one is
  // a 400. The schema and MAX_EDITS bound the output instead.
  const ai = fakeAi(answer([]));
  return tailor(INPUT, { ...creds, ...ai }).then(() => {
    assert.equal(ai.calls[0]!.body.max_tokens, undefined);
    assert.equal(ai.calls[0]!.body.max_completion_tokens, undefined);
  });
});

test('the model can be overridden, because which one writes best is measurable', () => {
  const ai = fakeAi(answer([]));
  return tailor(INPUT, { ...creds, ...ai, model: 'gpt-5.6-luna' }).then((res) => {
    assert.equal(ai.calls[0]!.body.model, 'gpt-5.6-luna');
    assert.equal(res.model, 'gpt-5.6-luna');
  });
});

test('the chips that were understood are reported back', () => {
  return tailor({ ...INPUT, chips: ['mirror', 'nope'] }, { ...creds, ...fakeAi(answer([])) }).then(
    (res) => {
      assert.deepEqual(res.used.map((c) => c.id), ['mirror']);
    },
  );
});

// ---------------------------------------------------------------------------
// Refusing before spending money
// ---------------------------------------------------------------------------

test('AN EMPTY RESUME IS REFUSED WITHOUT CALLING THE API', () => {
  // Every edit would be rejected for want of anything to verify against, after
  // paying for the call. This is also the state every account on the site is in
  // until somebody pastes a CV.
  const ai = fakeAi(answer([]));
  return tailor({ ...INPUT, resumeText: '   ' }, { ...creds, ...ai }).then((res) => {
    assert.equal(ai.calls.length, 0, 'it called OpenAI with nothing to tailor');
    assert.match(res.note, /add your resume first/i);
  });
});

test('a posting with no description is refused without calling the API', () => {
  // Six of the fourteen ATS vendors have no description path at all.
  const ai = fakeAi(answer([]));
  return tailor({ ...INPUT, jobDescription: '' }, { ...creds, ...ai }).then((res) => {
    assert.equal(ai.calls.length, 0);
    assert.match(res.note, /no description/i);
  });
});

test('A MISSING KEY IS REPORTED, AND AN EMPTY STRING COUNTS AS MISSING', () => {
  // The bug this project has already been bitten by once: GitHub sets a missing
  // secret to the empty string, which is not nullish, so a `??` chain treats it as
  // a perfectly good key and the failure surfaces as a puzzling 401 instead of
  // "it is not configured".
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  try {
    const ai = fakeAi(answer([]));
    return tailor(INPUT, { wait: noWait, ...ai }).then((res) => {
      assert.equal(ai.calls.length, 0);
      assert.match(res.note, /not configured/i);
      assert.equal(res.needsAttention, true, 'a person has to fix this, so say so');
    });
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

// ---------------------------------------------------------------------------
// Parsing what comes back
// ---------------------------------------------------------------------------

test('JSON INSIDE A CODE FENCE IS STILL READ', () => {
  // A real and common behaviour, and throwing away a good answer over three
  // backticks would be a silly way to lose the feature.
  const fenced = ['```json', answer([]), '```'].join('\n');
  const parsed = extractJson(fenced) as { edits: unknown[] };
  assert.deepEqual(parsed.edits, []);
});

test('JSON after a prose preface is still read', () => {
  const chatty = `Here are the edits I suggest:\n\n${answer([])}\n\nHope that helps.`;
  assert.ok(extractJson(chatty));
});

test('a body that is not JSON at all returns null rather than throwing', () => {
  assert.equal(extractJson('I am afraid I cannot help with that.'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('{ not json }'), null);
});

test('a non-JSON answer is reported, not thrown', () => {
  return tailor(INPUT, { ...creds, ...fakeAi('I cannot help with that.') }).then((res) => {
    assert.equal(res.edits.length, 0);
    assert.ok(res.note.length > 0);
  });
});

test('an empty answer is reported', () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  return tailor(INPUT, { ...creds, fetchImpl }).then((res) => {
    assert.match(res.note, /empty answer/i);
  });
});

test('a malformed edit becomes a rejected edit rather than discarded silently', () => {
  // Tolerance in one direction only: a broken field produces an empty field,
  // which verifyEdit refuses. Nothing in the parser decides an edit is acceptable.
  const { edits } = parseAnswer({
    edits: [{ original: 42, replacement: null, reason: undefined }, 'not an object', null],
    gaps: [],
  });
  assert.equal(edits.length, 3);
  for (const e of edits) assert.equal(e.original, '');
});

test('the number of edits and gaps is capped', () => {
  const many = Array.from({ length: MAX_EDITS + 20 }, (_, i) => ({
    original: `line ${i}`, replacement: `line ${i} better`, reason: 'x', section: '',
  }));
  const gaps = Array.from({ length: MAX_GAPS + 20 }, (_, i) => `gap ${i}`);
  const parsed = parseAnswer({ edits: many, gaps });
  assert.equal(parsed.edits.length, MAX_EDITS);
  assert.equal(parsed.gaps.length, MAX_GAPS);
});

test('gaps are tidied and empty ones dropped', () => {
  const parsed = parseAnswer({ edits: [], gaps: ['  spaced   out  ', '', '   ', 'x'.repeat(900)] });
  assert.deepEqual(parsed.gaps.slice(0, 2), ['spaced out', 'x'.repeat(300)]);
});

test('missing arrays are treated as empty rather than crashing', () => {
  assert.deepEqual(parseAnswer({}), { edits: [], gaps: [] });
  assert.deepEqual(parseAnswer(null), { edits: [], gaps: [] });
  assert.deepEqual(parseAnswer({ edits: 'nope', gaps: 7 }), { edits: [], gaps: [] });
});

// ---------------------------------------------------------------------------
// Failure, in the words a person needs
// ---------------------------------------------------------------------------

test('a refused key says so and does not retry', () => {
  const ai = fakeAi('{"error":{"message":"Incorrect API key"}}', 401);
  return tailor(INPUT, { ...creds, ...ai }).then((res) => {
    assert.equal(ai.calls.length, 1, 'a bad key will be just as bad on the third attempt');
    assert.match(res.note, /refused the API key/i);
    assert.equal(res.needsAttention, true);
  });
});

test('being rate limited or out of credit is not reported as permanent', () => {
  const ai = fakeAi('{"error":{"message":"rate limit"}}', 429);
  return tailor(INPUT, { ...creds, ...ai }).then((res) => {
    assert.match(res.note, /rate limiting|out of credit/i);
    assert.equal(res.needsAttention, false, 'this clears on its own; do not send anyone hunting');
  });
});

test('A REJECTED REQUEST NAMES THE MODEL', () => {
  // The likeliest cause of a 400 is a model name this account cannot use or a
  // parameter the generation dropped. "HTTP 400" on its own sends somebody
  // reading logs for an hour.
  const ai = fakeAi('{"error":{"message":"model not found"}}', 400);
  return tailor(INPUT, { ...creds, ...ai, model: 'gpt-9-imaginary' }).then((res) => {
    assert.match(res.note, /gpt-9-imaginary/);
    assert.equal(res.needsAttention, true);
  });
});

test('a server error is retried and then reported', () => {
  const ai = fakeAi('upstream exploded', 503);
  return tailor(INPUT, { ...creds, ...ai, attempts: 3 }).then((res) => {
    assert.equal(ai.calls.length, 3, 'a 503 is worth another go');
    assert.match(res.note, /OpenAI/);
    assert.equal(res.edits.length, 0);
  });
});

test('a dropped connection is retried', () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  return tailor(INPUT, { ...creds, fetchImpl, attempts: 2 }).then((res) => {
    assert.equal(calls, 2);
    assert.match(res.note, /unreachable/i);
  });
});

test('a transient failure that then succeeds returns the answer', () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: answer([]) } }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return tailor(INPUT, { ...creds, fetchImpl, attempts: 3 }).then((res) => {
    assert.equal(calls, 2);
    assert.match(res.note, /0 proposed|nothing/i);
  });
});

test('NOTHING HERE THROWS, WHATEVER THE RESPONSE', () => {
  // A person is waiting on this behind a web request. Every one of these used to
  // be a plausible way to turn a tailoring attempt into a 500.
  const bodies = ['', 'null', '[]', '{"choices":[]}', '{"choices":[{}]}', 'not json at all'];
  return Promise.all(
    bodies.map((b) => {
      const fetchImpl = (async () => new Response(b, { status: 200 })) as unknown as typeof fetch;
      return tailor(INPUT, { ...creds, fetchImpl, attempts: 1 }).then((res) => {
        assert.ok(res.note.length > 0, `no note for body ${JSON.stringify(b)}`);
        assert.equal(res.edits.length, 0);
      });
    }),
  );
});

test('AN EMPTY KEY ARGUMENT DOES NOT MASK A GOOD ONE IN THE ENVIRONMENT', () => {
  // The `??` trap, in the direction that actually loses a working key. A caller
  // reading a config value that happens to be '' and passing it through would,
  // with nullish coalescing, stop the chain at the empty string and report
  // "not configured" while a perfectly good key sat in the environment.
  //
  // A mutation swapping the lookup for `opts.apiKey ?? process.env.OPENAI_API_KEY`
  // passed every other test in this file, which is why this one exists.
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-from-env';
  try {
    const ai = fakeAi(answer([]));
    return tailor(INPUT, { wait: noWait, apiKey: '', ...ai }).then((res) => {
      assert.equal(ai.calls.length, 1, 'the environment key was never reached');
      assert.equal(ai.calls[0]!.auth, 'Bearer sk-from-env');
      assert.doesNotMatch(res.note, /not configured/i);
    });
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

test('a whitespace-only key is treated as absent rather than sent', () => {
  const before = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const ai = fakeAi(answer([]));
    return tailor(INPUT, { wait: noWait, apiKey: '   ', ...ai }).then((res) => {
      assert.equal(ai.calls.length, 0, 'it sent "Bearer    " to OpenAI');
      assert.match(res.note, /not configured/i);
    });
  } finally {
    if (before !== undefined) process.env.OPENAI_API_KEY = before;
  }
});
