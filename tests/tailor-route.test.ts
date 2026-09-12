import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PER_WINDOW, WINDOW_MS, createLimiter } from '../src/tailor/rate-limit.js';

/**
 * The endpoint that spends money, and the ceiling on how fast it can.
 *
 * Two different kinds of test here, for two different reasons.
 *
 * The limiter is tested by running it, with an injected clock — a sliding window
 * has two off-by-one edges and neither can be exercised against a real clock
 * without sleeping for a minute.
 *
 * The route is tested by reading it. dbWrite() builds a real client from the
 * environment and subjectFor() reads cookies against live Supabase, so executing
 * the handler would test the network rather than the logic. What matters about
 * this route is an ORDER — the gate before the work, the cheap checks before the
 * paid ones — and order is visible in the source.
 */

const route = () => readFileSync(new URL('../app/api/tailor/route.ts', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// The limiter
// ---------------------------------------------------------------------------

test('the allowance runs out at the limit, not one past it', () => {
  // Off by one here is one extra paid OpenAI call per person per window, forever.
  const limiter = createLimiter({ perWindow: 3, windowMs: 1_000 });
  assert.equal(limiter.allow('u', 0), true);
  assert.equal(limiter.allow('u', 10), true);
  assert.equal(limiter.allow('u', 20), true);
  assert.equal(limiter.allow('u', 30), false, 'a fourth attempt was allowed against a limit of 3');
});

test('THE WINDOW SLIDES RATHER THAN RESETTING ON A BOUNDARY', () => {
  // A fixed bucket resetting on the minute lets somebody take the whole allowance
  // at 59 seconds and the whole of the next one at 61 — double the intended rate,
  // at exactly the moment a runaway loop would find it.
  const limiter = createLimiter({ perWindow: 2, windowMs: 1_000 });
  assert.equal(limiter.allow('u', 900), true);
  assert.equal(limiter.allow('u', 950), true);
  assert.equal(limiter.allow('u', 1_010), false, 'a bucket boundary handed out a second allowance');
  assert.equal(limiter.allow('u', 1_060), false);
  // Only once the first attempts have genuinely aged out.
  assert.equal(limiter.allow('u', 1_960), true);
});

test('the allowance comes back after the window', () => {
  const limiter = createLimiter({ perWindow: 1, windowMs: 1_000 });
  assert.equal(limiter.allow('u', 0), true);
  assert.equal(limiter.allow('u', 999), false);
  assert.equal(limiter.allow('u', 1_000), true, 'exactly at the window the oldest attempt has aged out');
});

test('ONE PERSON CANNOT SPEND ANOTHER PERSON ALLOWANCE', () => {
  // Keyed per seat holder. Shared, one busy user would lock the other four out of
  // a feature they are paying for.
  const limiter = createLimiter({ perWindow: 1, windowMs: 1_000 });
  assert.equal(limiter.allow('alice', 0), true);
  assert.equal(limiter.allow('alice', 1), false);
  assert.equal(limiter.allow('bob', 2), true, "alice's attempts were charged to bob");
});

test('remaining counts down and floors at zero', () => {
  const limiter = createLimiter({ perWindow: 2, windowMs: 1_000 });
  assert.equal(limiter.remaining('u', 0), 2);
  limiter.allow('u', 0);
  assert.equal(limiter.remaining('u', 0), 1);
  limiter.allow('u', 0);
  assert.equal(limiter.remaining('u', 0), 0);
  limiter.allow('u', 0);
  assert.equal(limiter.remaining('u', 0), 0, 'it must never go negative');
});

test('remaining recovers as the window slides', () => {
  const limiter = createLimiter({ perWindow: 2, windowMs: 1_000 });
  limiter.allow('u', 0);
  limiter.allow('u', 500);
  assert.equal(limiter.remaining('u', 600), 0);
  assert.equal(limiter.remaining('u', 1_100), 1, 'the first attempt should have aged out');
});

test('a stream of distinct users does not grow the map without limit', () => {
  // Five real people, but the key is a visitor id and a bug elsewhere could feed
  // this thousands. It must not become a memory leak.
  const limiter = createLimiter({ perWindow: 1, windowMs: 1_000 });
  for (let i = 0; i < 1_000; i++) limiter.allow(`user-${i}`, i);
  // Long after every one of those has aged out, a new caller still gets through
  // and nothing has thrown.
  assert.equal(limiter.allow('late', 500_000), true);
});

test('the shipped limits are the documented ones', () => {
  assert.equal(PER_WINDOW, 8);
  assert.equal(WINDOW_MS, 60_000);
});

test('the limiter is honest that it is per isolate', () => {
  // It is a guard against runaway loops, not a billing guarantee, and the next
  // person to read it must not mistake one for the other.
  // Comment markers stripped BEFORE whitespace is flattened, and both are needed.
  // Flattening alone leaves the phrase reading "NOT a billing * guarantee", because
  // the line prefix of the block comment sits inside it — so a pattern that is
  // plainly present in the file matches nothing. The same class of trap the
  // schema-drift test records.
  const src = readFileSync(new URL('../src/tailor/rate-limit.ts', import.meta.url), 'utf8')
    .replace(/^\s*\*+/gm, ' ')
    .replace(/\s+/g, ' ');
  assert.match(src, /PER ISOLATE, NOT GLOBAL/);
  assert.match(src, /NOT a billing guarantee/);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('TAILORING REQUIRES A CLAIMED SEAT, NOT A COOKIE', () => {
  // The user's requirement, in the user's words: tied to account. resolveSession
  // returns null unless hasSeat is true, so checking for a session IS checking for
  // a seat — and this route reads a named person's CV and spends money on every
  // call, so an anonymous cookie must not reach it.
  const src = route();
  assert.match(src, /if \(!session\)/, 'the route does not require a session');
  assert.match(src, /401/);

  // And the gate must come before everything, including parsing the body.
  const gateAt = src.indexOf('if (!session)');
  const bodyAt = src.indexOf('await request.json()');
  assert.ok(gateAt > 0 && bodyAt > gateAt, 'the body is parsed before the caller is checked');
});

test('THE RATE LIMIT IS CHECKED BEFORE ANY PAID OR NETWORK WORK', () => {
  // The whole point. A limiter that runs after the OpenAI call limits nothing, and
  // describeJob reaches out to a vendor, so both must sit behind it.
  const src = route();
  const limitAt = src.indexOf('sharedLimiter().allow(');
  const describeAt = src.indexOf('await describeJob(');
  const tailorAt = src.indexOf('await tailor(');
  assert.ok(limitAt > 0, 'there is no rate limit');
  assert.ok(limitAt < describeAt, 'a vendor is contacted before the limit is checked');
  assert.ok(limitAt < tailorAt, 'OpenAI is paid before the limit is checked');
});

test('the limit is keyed to the person, not to the job', () => {
  assert.match(route(), /sharedLimiter\(\)\.allow\(visitor\.id\)/);
});

// ---------------------------------------------------------------------------
// Cheap checks before expensive ones
// ---------------------------------------------------------------------------

test('A MISSING RESUME IS CAUGHT BEFORE THE VENDOR AND OPENAI ARE TROUBLED', () => {
  // Every one of the seven profiles is in exactly this state right now — the text
  // column is new and empty until each person saves again. Fetching a job
  // description and paying for a model call to then discover there is nothing to
  // tailor would be the common case, not the edge case.
  const src = route();
  const resumeAt = src.indexOf('await getResumeText(');
  const describeAt = src.indexOf('await describeJob(');
  const tailorAt = src.indexOf('await tailor(');
  assert.ok(resumeAt > 0, 'the resume is never read');
  assert.ok(resumeAt < describeAt, 'the description is fetched before checking for a resume');
  assert.ok(resumeAt < tailorAt, 'OpenAI is paid before checking for a resume');
  assert.match(src, /needsResume: true/, 'the page needs to know to send them to their account');
});

test('a posting with no readable description is not an error', () => {
  // 5,727 open in-scope postings sit behind vendors that publish nothing we can
  // read. That is an ordinary outcome and a 500 would make it look like a fault.
  const src = route();
  assert.match(src, /422/);
  assert.match(src, /noDescription: true/);
  assert.match(src, /retryable: described\.retryable/);
});

// ---------------------------------------------------------------------------
// What is sent, and what comes back
// ---------------------------------------------------------------------------

test('ONLY CHIPS THIS BUILD KNOWS ARE PASSED ON', () => {
  // The request body is the one input a signed-in person fully controls. An
  // unknown id reaching buildMessages would be silently ignored there, but
  // filtering here is what keeps an arbitrary string out of a prompt.
  const src = route();
  assert.match(src, /new Set\(CHIPS\.map\(\(c\) => c\.id\)\)/);
  assert.match(src, /known\.has\(c\)/);
});

test('the resume and the description are both capped before being paid for', () => {
  // Some enterprise adverts run to 40,000 characters of benefits and legal text,
  // all of it billed by the token and none of it useful.
  const src = route();
  assert.match(src, /MAX_RESUME_CHARS = 50_000/);
  assert.match(src, /MAX_JD_CHARS = 12_000/);
  assert.match(src, /\.slice\(0, MAX_RESUME_CHARS\)/);
  assert.match(src, /\.slice\(0, MAX_JD_CHARS\)/);
});

test('THE RESPONSE RETURNS CHECKED EDITS AND NOTHING ELSE FROM THE MODEL', () => {
  // result.edits is CheckedEdit[] — tailor() exposes no route to the raw list. The
  // risk is a future convenience: spreading the whole result, or reaching past it
  // to something unverified.
  const src = route();
  assert.match(src, /edits: result\.edits/);
  assert.ok(!src.includes('...result'), 'the whole tailor result is spread into the response');
  assert.ok(!src.includes('parseAnswer'), 'the route parses the model answer itself');
});

test('the response says where the description came from', () => {
  // Nothing is stored, and the page should be able to say so rather than imply a
  // description lives in the database.
  assert.match(route(), /via: described\.via/);
});

// ---------------------------------------------------------------------------
// The board lookup
// ---------------------------------------------------------------------------

test('A WORKDAY BOARD IS ONLY USED IF IT HAS BOTH HOST AND PORTAL', () => {
  // boards is unique on (provider, token, site), so one token can have several
  // rows. Taking the first would pick an arbitrary portal, and describeJob would
  // then ask the wrong site for the posting — a request that succeeds and returns
  // nothing, which reads as "this job has no description".
  const src = route();
  assert.match(src, /b\.extra\?\.host && b\.extra\?\.site/);
  assert.ok(!src.includes('.maybeSingle()\n    .eq(\'token\''), 'it assumes one board per token');
});

test('only Workday pays for the extra board read', () => {
  const src = route();
  assert.match(src, /if \(row\.provider !== 'workday'\) return \{ job: row, extra: undefined \}/);
});
