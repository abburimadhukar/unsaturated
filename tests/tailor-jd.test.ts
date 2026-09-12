import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_USEFUL_CHARS, canDescribe, describeJob, parseJobKey } from '../src/tailor/jd.js';

/**
 * Finding one job's description, on demand.
 *
 * There is no `description` column and there never has been, so tailoring has to
 * ask the vendor again for the one posting somebody opened. What these tests hold
 * is mostly about being honest when that cannot be done: six of the fourteen ATS
 * vendors publish nothing we can read, and 5,727 open in-scope postings sit behind
 * them. Telling someone "no description available" is useful; tailoring their CV
 * against a job title would not be.
 */

const LONG = 'We need a platform engineer. '.repeat(20); // comfortably over the floor
const body = (json: unknown, status = 200) =>
  new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

/** Records every URL asked for, and answers with whatever it is given. */
function spy(answer: (url: string) => Response) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    return answer(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

// ---------------------------------------------------------------------------
// Reading a job key
// ---------------------------------------------------------------------------

test('A KEY IS SPLIT ON THE FIRST TWO COLONS, NOT ON EVERY COLON', () => {
  // An externalId can contain colons, and Workday's IS a URL path. Splitting on
  // every colon would truncate the identifier and send the vendor asking about a
  // posting that does not exist — a request that succeeds and returns the wrong
  // thing, or nothing, with no error to notice.
  const id = parseJobKey('workday:acme:/job/London/Platform-Engineer_R-123:extra');
  assert.deepEqual(id, {
    provider: 'workday',
    token: 'acme',
    externalId: '/job/London/Platform-Engineer_R-123:extra',
  });
});

test("a Workday path survives intact, because it IS the detail endpoint's argument", () => {
  const id = parseJobKey('workday:nab/en-US:/job/Melbourne/DevOps-Engineer_REQ-9');
  assert.equal(id?.externalId, '/job/Melbourne/DevOps-Engineer_REQ-9');
});

test('an ordinary numeric id is read correctly', () => {
  assert.deepEqual(parseJobKey('greenhouse:stripe:4567890'), {
    provider: 'greenhouse',
    token: 'stripe',
    externalId: '4567890',
  });
});

test('a malformed key is refused rather than half-read', () => {
  for (const bad of ['', 'workday', 'workday:acme', 'workday:acme:', ':acme:123', 'workday::123']) {
    assert.equal(parseJobKey(bad), null, `"${bad}" was accepted`);
  }
});

// ---------------------------------------------------------------------------
// Which vendors can be asked at all
// ---------------------------------------------------------------------------

test('the two reachable groups are recognised, and the rest are not', () => {
  for (const p of ['workday', 'smartrecruiters', 'workable', 'bamboohr']) {
    assert.equal(canDescribe(p), true, `${p} has a detail endpoint`);
  }
  for (const p of ['greenhouse', 'lever', 'ashby']) {
    assert.equal(canDescribe(p), true, `${p} carries descriptions in its listing`);
  }
  for (const p of ['personio', 'breezy', 'rippling', 'teamtailor', 'recruitee', 'ukg']) {
    assert.equal(canDescribe(p), false, `${p} has no description path`);
  }
  assert.equal(canDescribe('nonsense'), false);
});

test('A VENDOR WITH NO DESCRIPTION SAYS SO AND IS NOT WORTH RETRYING', () => {
  // 5,727 open in-scope postings, measured 12 September 2026. The UI uses
  // retryable:false to hide the button rather than offer a feature that cannot
  // work here, so getting this flag wrong would put a dead button on 5,727 jobs.
  const s = spy(() => body({}));
  return describeJob({ key: 'rippling:acme:123', title: 'DevOps Engineer' }, s).then((res) => {
    assert.equal(res.ok, false);
    assert.equal(s.urls.length, 0, 'it went to the network for a vendor that has nothing');
    if (!res.ok) {
      assert.equal(res.retryable, false);
      assert.match(res.reason, /rippling/);
    }
  });
});

// ---------------------------------------------------------------------------
// The detail route
// ---------------------------------------------------------------------------

test('WORKDAY IS ASKED AT THE ADDRESS BUILT FROM ITS PATH', () => {
  // The whole reason Workday works at all: its adapter stored externalPath AS the
  // externalId, so the key carries the one field the detail endpoint needs and
  // that nothing in the database keeps.
  const s = spy(() => body({ jobPostingInfo: { jobDescription: `<p>${LONG}</p>` } }));
  return describeJob(
    { key: 'workday:acme:/job/London/Platform-Engineer_R-123', title: 'Platform Engineer' },
    { ...s, extra: { host: 'acme.wd3.myworkdayjobs.com', site: 'External' } },
  ).then((res) => {
    assert.equal(res.ok, true, res.ok ? '' : res.reason);
    assert.equal(s.urls.length, 1);
    assert.equal(
      s.urls[0],
      'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/London/Platform-Engineer_R-123',
    );
    if (res.ok) {
      assert.equal(res.via, 'detail');
      assert.ok(res.text.includes('platform engineer'), 'the HTML should have been stripped to text');
      assert.ok(!res.text.includes('<p>'), 'markup must not reach the model');
    }
  });
});

test('WORKDAY WITHOUT ITS HOST AND PORTAL IS REFUSED BEFORE ANY REQUEST', () => {
  // Both live on the board row, not in the job key. Left unchecked, the URL would
  // be built against "https://undefined/..." — a request that fails in a way that
  // looks like the vendor's fault.
  const s = spy(() => body({}));
  return Promise.all([
    describeJob({ key: 'workday:acme:/job/X', title: 'T' }, s),
    describeJob({ key: 'workday:acme:/job/X', title: 'T' }, { ...s, extra: { host: 'h.com' } }),
    describeJob({ key: 'workday:acme:/job/X', title: 'T' }, { ...s, extra: { site: 'External' } }),
  ]).then((results) => {
    assert.equal(s.urls.length, 0, 'it built a request with a missing host or portal');
    for (const res of results) {
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.reason, /missing the address/i);
    }
  });
});

test('a stub of a description is not treated as a description', () => {
  // Short bodies are location lines and application instructions. Tailoring
  // against one would produce confident nonsense.
  const s = spy(() => body({ jobPostingInfo: { jobDescription: 'Apply online.' } }));
  return describeJob(
    { key: 'workday:acme:/job/X', title: 'T' },
    { ...s, extra: { host: 'h.com', site: 'External' } },
  ).then((res) => {
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /stub/i);
  });
});

test('a detail page with no description at all says the employer published none', () => {
  const s = spy(() => body({ jobPostingInfo: {} }));
  return describeJob(
    { key: 'workday:acme:/job/X', title: 'T' },
    { ...s, extra: { host: 'h.com', site: 'External' } },
  ).then((res) => {
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.reason, /did not publish/i);
      assert.equal(res.retryable, true, 'an empty detail page today can be filled in tomorrow');
    }
  });
});

test('the floor is the documented one', () => {
  assert.equal(MIN_USEFUL_CHARS, 200);
});

// ---------------------------------------------------------------------------
// The listing route
// ---------------------------------------------------------------------------

const greenhouseBoard = (ids: { id: number; content: string }[]) => ({
  jobs: ids.map((j) => ({
    id: j.id,
    title: `Role ${j.id}`,
    content: j.content,
    absolute_url: `https://boards.greenhouse.io/acme/jobs/${j.id}`,
  })),
});

test('THE RIGHT POSTING IS PICKED OUT OF A BOARD LISTING', () => {
  // Greenhouse and friends have no per-posting endpoint in the shape this code
  // uses, so the board is fetched through the adapter the crawl already uses and
  // the posting found by id. Picking the wrong one would tailor a CV against a
  // different job entirely, which is the worst available outcome.
  const s = spy(() =>
    body(
      greenhouseBoard([
        { id: 111, content: `<p>Wrong job. ${LONG}</p>` },
        { id: 222, content: `<p>The right one. ${LONG}</p>` },
      ]),
    ),
  );
  return describeJob({ key: 'greenhouse:acme:222', title: 'Role 222' }, s).then((res) => {
    assert.equal(res.ok, true, res.ok ? '' : res.reason);
    if (res.ok) {
      assert.equal(res.via, 'listing');
      assert.ok(res.text.includes('The right one'), 'it returned a different posting');
      assert.ok(!res.text.includes('Wrong job'));
    }
  });
});

test('A POSTING THAT HAS LEFT THE BOARD IS REPORTED AS PROBABLY CLOSED', () => {
  // The most useful thing a person can learn about a job they were about to spend
  // effort on, and the commonest reason a lookup comes back empty.
  const s = spy(() => body(greenhouseBoard([{ id: 111, content: `<p>${LONG}</p>` }])));
  return describeJob({ key: 'greenhouse:acme:999', title: 'Gone' }, s).then((res) => {
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.reason, /no longer on the employer board|closed/i);
      assert.equal(res.retryable, false, 'a closed posting will not reappear');
    }
  });
});

// ---------------------------------------------------------------------------
// Failure, without an exception
// ---------------------------------------------------------------------------

test('NOTHING HERE THROWS, WHATEVER THE VENDOR DOES', () => {
  // A person is waiting on this behind a web request, and a vendor being slow,
  // broken or hostile is an ordinary Tuesday across 27,000 boards.
  const cases: (() => typeof fetch)[] = [
    () => (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch,
    () => (async () => new Response('upstream exploded', { status: 503 })) as unknown as typeof fetch,
    () => (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    () => (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
  ];
  return Promise.all(
    cases.map((make) =>
      describeJob({ key: 'greenhouse:acme:222', title: 'T' }, { fetchImpl: make() }).then((res) => {
        assert.equal(res.ok, false);
        if (!res.ok) assert.ok(res.reason.length > 0, 'a failure with no sentence to show');
      }),
    ),
  );
});

test('an unreadable vendor response is reported as worth retrying', () => {
  const s = spy(() => new Response('gateway timeout', { status: 504 }));
  return describeJob({ key: 'greenhouse:acme:222', title: 'T' }, s).then((res) => {
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
  });
});
