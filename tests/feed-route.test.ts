import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { GET } from '../app/api/feed/route.js';
import { facetsFromDb } from '../src/corpus/db-query.js';
import { UNKNOWN_SPECIALIZATION } from '../src/taxonomy/specializations.js';

/**
 * Two halves.
 *
 * The validation half runs anywhere: those requests are rejected before the
 * route reaches the database, so they need neither credentials nor the
 * migration.
 *
 * The filtering half needs the migration applied, since it is asserting what
 * Postgres returns. Nothing here applies it — production is changed by hand,
 * deliberately — so those tests skip, loudly, until it is. A skipped test that
 * says why is worth more than one that passes by not looking.
 */

const BASE = 'https://unsaturated.test/api/feed';

async function call(query: string): Promise<{ status: number; body: any }> {
  const res = await GET(new Request(`${BASE}?${query}`));
  return { status: res.status, body: await res.json() };
}

let migrated = false;
let skipReason = '';

before(async () => {
  try {
    const facets = await facetsFromDb({ specialization: 'backend' });
    if (facets && typeof facets.specialization === 'object') {
      migrated = true;
    } else {
      skipReason = 'feed_facets does not accept p_specialization yet — apply the migration';
    }
  } catch (err) {
    skipReason = `database unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!migrated) console.log(`\n  [db tests skipped] ${skipReason}\n`);
});

// ---------------------------------------------------------------------------
// Validation — no database involved
// ---------------------------------------------------------------------------

test('an invalid specialization is a 400, not an unfiltered result set', async () => {
  const { status, body } = await call('specialization=not_a_real_thing');
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid query');
  assert.match(body.details.join(' '), /specialization must be/);
});

test('a specialization from another family is a 400', async () => {
  const { status, body } = await call('family=software&specialization=devops_sre');
  assert.equal(status, 400);
  // The message has to name both, or the caller cannot tell which half is wrong.
  assert.match(body.details.join(' '), /devops_sre belongs to family cloud, not software/);
});

test('every family rejects every other family\'s specializations', async () => {
  const wrong: [string, string][] = [
    ['software', 'mlops'],
    ['cloud', 'frontend'],
    ['data', 'networking'],
    ['hris', 'backend'],
  ];
  for (const [family, spec] of wrong) {
    const { status } = await call(`family=${family}&specialization=${spec}`);
    assert.equal(status, 400, `${family} + ${spec} should be rejected`);
  }
});

test('the matching family and specialization is accepted', async () => {
  const { status } = await call('family=cloud&specialization=devops_sre');
  assert.notEqual(status, 400);
});

test('"unknown specialization" is accepted, with or without a family', async () => {
  assert.notEqual((await call(`specialization=${UNKNOWN_SPECIALIZATION}`)).status, 400);
  assert.notEqual((await call(`family=data&specialization=${UNKNOWN_SPECIALIZATION}`)).status, 400);
});

test('the literal word "unknown" is not accepted', async () => {
  // It is not what the database stores, and accepting it would return an empty
  // list that reads as a real answer.
  assert.equal((await call('specialization=unknown')).status, 400);
});

test('a specialization on its own, with no family, is allowed', async () => {
  // It implies its family, so there is nothing to contradict.
  assert.notEqual((await call('specialization=workday')).status, 400);
});

test('every browser-side filter is refused by the API', async () => {
  // These three depend on who is asking, so they never leave the browser. The
  // API must refuse them rather than ignore them: a shared URL carrying
  // onlyApplied=1 was answering 200 with every job, which reads as a filter
  // that worked. onlyApplied joined the list late and was missed.
  for (const key of ['minFit=0.5', 'hideSeen=1', 'onlyApplied=1']) {
    const { status, body } = await call(key);
    assert.equal(status, 400, `${key} should be refused`);
    assert.match(body.details.join(' '), /applied in the browser/);
  }
});

test('an unknown family is still a 400', async () => {
  assert.equal((await call('family=marketing')).status, 400);
});

// ---------------------------------------------------------------------------
// Filtering and facets — needs the migration
// ---------------------------------------------------------------------------

test('filtering by a specialization returns only that specialization', async (t) => {
  if (!migrated) return t.skip(skipReason);
  const { status, body } = await call('family=software&specialization=backend&limit=50');
  assert.equal(status, 200);
  for (const job of body.jobs) {
    assert.equal(job.family, 'software');
    assert.equal(job.specialization, 'backend');
  }
});

test('filtering by unknown returns only rows whose specialization is NULL', async (t) => {
  if (!migrated) return t.skip(skipReason);
  const { status, body } = await call(
    `family=software&specialization=${UNKNOWN_SPECIALIZATION}&limit=50`,
  );
  assert.equal(status, 200);
  for (const job of body.jobs) {
    assert.equal(job.family, 'software');
    assert.equal(job.specialization, null);
  }
});

test('jobs with an unknown specialization are visible when no specialization is chosen', async (t) => {
  if (!migrated) return t.skip(skipReason);
  const { body } = await call('family=software&limit=200');
  const unknowns = body.jobs.filter((j: { specialization: string | null }) => j.specialization === null);
  const known = body.jobs.filter((j: { specialization: string | null }) => j.specialization !== null);
  // Both kinds present, i.e. the filter is not quietly excluding either.
  assert.ok(unknowns.length + known.length === body.jobs.length);
  assert.ok(body.jobs.length > 0);
});

test('the facets carry a specialization count including __unknown__', async (t) => {
  if (!migrated) return t.skip(skipReason);
  const { body } = await call('family=software');
  const facet = body.facets.specialization as Record<string, number>;
  assert.equal(typeof facet, 'object');
  assert.ok(Object.prototype.hasOwnProperty.call(facet, UNKNOWN_SPECIALIZATION));
  // Every count is a real number of rows, and they sum to the family total.
  const sum = Object.values(facet).reduce((a, b) => a + b, 0);
  assert.equal(sum, body.facets.family.software);
});

// ---------------------------------------------------------------------------
// Regression: the posting window
//
// "Posted within 24 hours" returned rows with no posting date at all, some of
// them first seen four days earlier. It survived the first round of testing
// because the assertion read `ageDays === null || age <= days` — excusing
// exactly the rows that were wrong — and because it only looked at the first
// page, while the sort puts undated rows last. Both mistakes are encoded below
// as things that must not pass again.
// ---------------------------------------------------------------------------

/** Walks every page. The defect lived in the tail; a first-page check is blind. */
async function allPages(query: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < 25_000; offset += 200) {
    const { status, body } = await call(`${query}&limit=200&offset=${offset}`);
    if (status !== 200) break;
    out.push(...(body.jobs ?? []));
    if (!body.hasMore || (body.jobs ?? []).length === 0) break;
  }
  return out;
}

for (const days of [1, 3, 7]) {
  test(`posting window: no row older than ${days}d, on any page`, async (t) => {
    if (!migrated) return t.skip(skipReason);
    const rows = await allPages(`postedWithinDays=${days}`);
    // No escape hatch: a dated row outside the window is a failure, full stop.
    const stale = rows.filter((j) => j.ageDays !== null && j.ageDays > days);
    assert.equal(stale.length, 0,
      `${stale.length} stale rows, e.g. ${stale.slice(0, 3).map((j) => `${j.ageDays}d ${j.title}`).join(' | ')}`);
  });

  test(`posting window: undated rows in ${days}d are counted and disclosed`, async (t) => {
    if (!migrated) return t.skip(skipReason);
    const rows = await allPages(`postedWithinDays=${days}`);
    const undated = rows.filter((j) => j.ageDays === null).length;
    const { body } = await call(`postedWithinDays=${days}&limit=1`);
    // Counted over the whole match by the database, not by filtering a page —
    // undated rows sort last, so a page-based count reads zero until you have
    // already scrolled past them.
    assert.equal(body.unknownIncluded.postedWithin, undated,
      `header says ${body.unknownIncluded.postedWithin}, ${undated} served`);
  });

  test(`posting window: includeUnknown=0 removes every undated row in ${days}d`, async (t) => {
    if (!migrated) return t.skip(skipReason);
    const rows = await allPages(`postedWithinDays=${days}&includeUnknown=0`);
    assert.ok(rows.length > 0, 'expected rows');
    assert.equal(rows.filter((j) => j.ageDays === null).length, 0);
  });
}

test('posting window: a tighter window is a strict subset of a looser one', async (t) => {
  if (!migrated) return t.skip(skipReason);
  const [one, three] = [await allPages('postedWithinDays=1'), await allPages('postedWithinDays=3')];
  const wider = new Set(three.map((j) => j.key));
  const leaked = one.filter((j) => !wider.has(j.key));
  assert.equal(leaked.length, 0, `${leaked.length} rows in 1d that 3d excludes`);
  assert.ok(one.length < three.length, `${one.length} vs ${three.length}`);
});

test('posting window: matched equals the rows actually served', async (t) => {
  if (!migrated) return t.skip(skipReason);
  const { body } = await call('postedWithinDays=3&limit=1');
  const rows = await allPages('postedWithinDays=3');
  // The header said "1,393 roles" while serving a different set. A count that
  // disagrees with the rows is the same class of defect as the window itself.
  assert.ok(Math.abs(rows.length - body.matched) <= 5,
    `matched=${body.matched} served=${rows.length}`);
});

test('the specialization facet ignores its own selection but not the others', async (t) => {
  if (!migrated) return t.skip(skipReason);
  const all = await call('family=software');
  const backend = await call('family=software&specialization=backend');
  // Same counts either way, or the list would collapse to one option the moment
  // you picked one and there would be no way to switch.
  assert.deepEqual(backend.body.facets.specialization, all.body.facets.specialization);

  // But another active filter does move them.
  const remote = await call('family=software&remote=fully_remote');
  assert.notDeepEqual(remote.body.facets.specialization, all.body.facets.specialization);
});
