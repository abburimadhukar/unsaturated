import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bambooHrAdapter } from '../src/ats/adapters/bamboohr.js';
import { ukgAdapter } from '../src/ats/adapters/ukg.js';
import { recruiteeAdapter } from '../src/ats/adapters/recruitee.js';
import { teamtailorAdapter } from '../src/ats/adapters/teamtailor.js';
import { ADAPTERS, SUPPORTED_PROVIDERS } from '../src/ats/adapters/index.js';
import type { FetchContext } from '../src/ats/types.js';

/**
 * BambooHR and UKG, the two enterprise suites with a usable public API.
 *
 * They matter for WHO uses them rather than how much they return: BambooHR is
 * mid-market North America, 50 to 500 people, companies that never appear on
 * Greenhouse — 3,281 such boards exist in the web archive and the corpus held
 * none. UKG adds 1,580 more.
 *
 * Both are driven here through a stub fetch, so the suite asserts on the
 * parsing rather than on other people's servers being up.
 */

const ctx = (body: unknown, status = 200): FetchContext =>
  ({
    userAgent: 'test',
    timeoutMs: 5000,
    fetchImpl: async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  }) as unknown as FetchContext;

// ---------------------------------------------------------------------------
// BambooHR
// ---------------------------------------------------------------------------

const bamboo = (result: unknown[]) => ({ meta: {}, result });

test('BambooHR reads a posting', async () => {
  const jobs = await bambooHrAdapter.fetchJobs(
    { provider: 'bamboohr', token: 'acme' },
    ctx(bamboo([{
      id: 83,
      jobOpeningName: 'Senior Technical Designer ',
      departmentLabel: 'Design',
      employmentStatusLabel: 'Full-Time',
      location: { city: 'Warrington', state: 'Cheshire' },
    }])),
  );
  assert.equal(jobs.length, 1);
  const j = jobs[0]!;
  assert.equal(j.externalId, '83');
  assert.equal(j.title, 'Senior Technical Designer');
  assert.equal(j.locationRaw, 'Warrington, Cheshire');
  assert.equal(j.employmentType, 'Full-Time');
  assert.equal(j.department, 'Design');
  assert.match(j.applyUrl!, /acme\.bamboohr\.com\/careers\/83/);
});

test('BambooHR joins the two location objects without repeating itself', async () => {
  // It fills in whichever of `location` and `atsLocation` it has, and several
  // boards put the state in both — which produced "Texas, Texas".
  const jobs = await bambooHrAdapter.fetchJobs(
    { provider: 'bamboohr', token: 'acme' },
    ctx(bamboo([{
      id: 1, jobOpeningName: 'Engineer',
      location: { city: null, state: 'Texas' },
      atsLocation: { city: 'Austin', state: 'Texas', country: 'United States' },
    }])),
  );
  // City, then state, then country — and "Texas" once, though it appears in
  // both objects.
  assert.equal(jobs[0]!.locationRaw, 'Austin, Texas, United States');
});

test('BambooHR trusts the employer over the location string', async () => {
  const remote = await bambooHrAdapter.fetchJobs(
    { provider: 'bamboohr', token: 'a' },
    ctx(bamboo([{ id: 1, jobOpeningName: 'Engineer', locationType: '1' }])),
  );
  assert.equal(remote[0]!.remoteType, 'fully_remote');
  const hybrid = await bambooHrAdapter.fetchJobs(
    { provider: 'bamboohr', token: 'a' },
    ctx(bamboo([{ id: 2, jobOpeningName: 'Engineer', locationType: '2' }])),
  );
  assert.equal(hybrid[0]!.remoteType, 'hybrid');
});

test('BambooHR drops a posting with no title or no id', async () => {
  // Either one makes the row unclassifiable, unmatchable and blank on screen.
  const jobs = await bambooHrAdapter.fetchJobs(
    { provider: 'bamboohr', token: 'a' },
    ctx(bamboo([
      { id: 1, jobOpeningName: '   ' },
      { jobOpeningName: 'No id here' },
      { id: 3, jobOpeningName: 'Real Job' },
    ])),
  );
  assert.deepEqual(jobs.map((j) => j.title), ['Real Job']);
});

test('BambooHR survives an empty or malformed board', async () => {
  assert.deepEqual(await bambooHrAdapter.fetchJobs({ provider: 'bamboohr', token: 'a' }, ctx(bamboo([]))), []);
  assert.deepEqual(await bambooHrAdapter.fetchJobs({ provider: 'bamboohr', token: 'a' }, ctx({})), []);
});

// ---------------------------------------------------------------------------
// UKG
// ---------------------------------------------------------------------------

const ukgBody = (opportunities: unknown[], totalCount = opportunities.length) =>
  ({ opportunities, totalCount });

const UKG_BOARD = { provider: 'ukg' as const, token: 'AAM1000AAM', extra: { board: 'c5a88c41-a6d1-4e5d-bf94-4d0432a0df30' } };

test('UKG reads a posting', async () => {
  const jobs = await ukgAdapter.fetchJobs(UKG_BOARD, ctx(ukgBody([{
    Id: 'abc', Title: 'Compliance Administrator', FullTime: true,
    JobCategoryName: 'Community Management',
    Locations: [{ Address: { City: 'Southgate', State: { Name: 'Michigan' }, Country: { Name: 'United States' } } }],
  }])));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.title, 'Compliance Administrator');
  assert.equal(jobs[0]!.locationRaw, 'Southgate, Michigan, United States');
  assert.equal(jobs[0]!.employmentType, 'Full-Time');
});

test('UKG refuses a board with no board id rather than returning nothing', async () => {
  // A silent empty result would look exactly like a company with no openings.
  await assert.rejects(
    () => ukgAdapter.fetchJobs({ provider: 'ukg', token: 'AAM1000AAM' }, ctx(ukgBody([]))),
    /no extra\.board id/,
  );
});

test('UKG falls back to the free-text location when the address is empty', async () => {
  const jobs = await ukgAdapter.fetchJobs(UKG_BOARD, ctx(ukgBody([{
    Id: '1', Title: 'Engineer',
    Locations: [{ LocalizedDescription: 'Remote - US', Address: null }],
  }])));
  assert.equal(jobs[0]!.locationRaw, 'Remote - US');
});

test('UKG does not repeat a posting when pages overlap', async () => {
  // Some boards return the same row on consecutive pages. A duplicate key would
  // be rejected by the upsert later; dropping it here is cheaper.
  const jobs = await ukgAdapter.fetchJobs(UKG_BOARD, ctx(ukgBody(
    [{ Id: 'x', Title: 'One' }, { Id: 'x', Title: 'One again' }],
  )));
  assert.equal(jobs.length, 1);
});

test('UKG stops instead of paging forever', async () => {
  // A board reporting a totalCount it never reaches would otherwise loop until
  // the crawl timed out, taking every board behind it in the shard with it.
  let calls = 0;
  const forever = {
    userAgent: 'test', timeoutMs: 5000,
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify(ukgBody(
        Array.from({ length: 50 }, (_, i) => ({ Id: `${calls}-${i}`, Title: 'Job' })),
        999_999,
      )), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  } as unknown as FetchContext;
  const jobs = await ukgAdapter.fetchJobs(UKG_BOARD, forever);
  assert.ok(calls <= 20, `paged ${calls} times`);
  assert.ok(jobs.length <= 20 * 50);
});

test('UKG reads totalCount once, not on every page', async () => {
  // Workday sends a total of 0 after the first page, and reassigning each time
  // made every board look 40 jobs deep. The same bug is easy to write here.
  let calls = 0;
  const shrinking = {
    userAgent: 'test', timeoutMs: 5000,
    fetchImpl: async () => {
      calls++;
      const total = calls === 1 ? 120 : 0;
      return new Response(JSON.stringify(ukgBody(
        Array.from({ length: 50 }, (_, i) => ({ Id: `p${calls}-${i}`, Title: 'Job' })),
        total,
      )), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  } as unknown as FetchContext;
  const jobs = await ukgAdapter.fetchJobs(UKG_BOARD, shrinking);
  assert.ok(jobs.length > 50, `stopped at ${jobs.length} — the total was re-read`);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('UKG honours the host a board was found on', async () => {
  // UKG serves from recruiting.ultipro.com AND recruiting2.ultipro.com, and a
  // board on one does not answer on the other. 618 boards were harvested from
  // recruiting2, verified against recruiting, and every one came back 404 and
  // was recorded as dead — so the host is part of a board's identity, not a
  // constant.
  let seen = '';
  const capture = {
    userAgent: 'test', timeoutMs: 5000,
    fetchImpl: async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ opportunities: [{ Id: '1', Title: 'Job' }], totalCount: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
  } as unknown as FetchContext;

  await ukgAdapter.fetchJobs(
    { provider: 'ukg', token: 'ABC', extra: { board: 'b-1', host: 'recruiting2.ultipro.com' } },
    capture,
  );
  assert.match(seen, /^https:\/\/recruiting2\.ultipro\.com\/ABC\//, `called ${seen}`);

  // A row stored before the host was captured still has to work.
  await ukgAdapter.fetchJobs({ provider: 'ukg', token: 'ABC', extra: { board: 'b-1' } }, capture);
  assert.match(seen, /^https:\/\/recruiting\.ultipro\.com\/ABC\//, `called ${seen}`);
});

test('the apply link points at the host the board lives on', async () => {
  const jobs = await ukgAdapter.fetchJobs(
    { provider: 'ukg', token: 'ABC', extra: { board: 'b-1', host: 'recruiting2.ultipro.com' } },
    ctx(ukgBody([{ Id: '9', Title: 'Engineer' }])),
  );
  // An apply link on the wrong host is a 404 for whoever clicks it.
  assert.match(jobs[0]!.applyUrl!, /recruiting2\.ultipro\.com/);
});

test('both are registered so the crawler can reach them', () => {
  for (const p of ['bamboohr', 'ukg'] as const) {
    assert.ok(SUPPORTED_PROVIDERS.includes(p), `${p} is not a supported provider`);
    assert.equal(ADAPTERS[p].provider, p);
  }
});

// ---------------------------------------------------------------------------
// Recruitee and Teamtailor
//
// Both matter for one reason beyond volume: their listing carries the
// DESCRIPTION. Most providers make that a second request per job, which is why
// the crawl only backfills descriptions for postings that already look
// relevant — so a family the description would have revealed is never seen.
// These two arrive complete.
// ---------------------------------------------------------------------------

test('Recruitee reads a posting, description included', async () => {
  const jobs = await recruiteeAdapter.fetchJobs(
    { provider: 'recruitee', token: 'acme' },
    ctx({ offers: [{
      id: 2694504, title: 'Data Engineer', city: 'Nijverdal', state_name: 'Overijssel',
      country: 'Nederland', country_code: 'NL', department: 'Operations',
      employment_type_code: 'fulltime_permanent', hybrid: true, experience_code: 'mid_level',
      published_at: '2026-08-05 13:17:11 UTC',
      description: '<p>Build pipelines with Python and dbt.</p>',
      requirements: '<p>5 years SQL.</p>',
      careers_apply_url: 'https://acme.recruitee.com/o/data-engineer/apply',
      careers_url: 'https://acme.recruitee.com/o/data-engineer',
    }] }),
  );
  assert.equal(jobs.length, 1);
  const j = jobs[0]!;
  assert.equal(j.title, 'Data Engineer');
  assert.equal(j.locationRaw, 'Nijverdal, Overijssel, Nederland');
  assert.equal(j.country, 'NL');
  assert.equal(j.remoteType, 'hybrid');
  assert.equal(j.employmentType, 'Full-time');
  // Description AND requirements: the classifier reads whatever text exists,
  // and half of it living in a second field is easy to miss.
  assert.match(j.descriptionText!, /Python and dbt/);
  assert.match(j.descriptionText!, /5 years SQL/);
});

test('Recruitee trusts the three arrangement booleans over the location text', async () => {
  const mk = async (o: Record<string, unknown>) =>
    (await recruiteeAdapter.fetchJobs({ provider: 'recruitee', token: 'a' },
      ctx({ offers: [{ id: 1, title: 'Engineer', ...o }] })))[0]!;
  assert.equal((await mk({ remote: true })).remoteType, 'fully_remote');
  assert.equal((await mk({ hybrid: true })).remoteType, 'hybrid');
  assert.equal((await mk({ on_site: true })).remoteType, 'on_site');
  // All three false is a real state: the employer said nothing.
  assert.equal((await mk({})).remoteType, undefined);
});

test('Recruitee skips an offer that is no longer published', async () => {
  // Closed offers stay in the feed. Showing one puts a role on the site that
  // cannot be applied for.
  const jobs = await recruiteeAdapter.fetchJobs(
    { provider: 'recruitee', token: 'a' },
    ctx({ offers: [
      { id: 1, title: 'Closed Role', status: 'closed' },
      { id: 2, title: 'Open Role', status: 'published' },
    ] }),
  );
  assert.deepEqual(jobs.map((j) => j.title), ['Open Role']);
});

test('Teamtailor reads the schema.org block, not just the feed item', async () => {
  const jobs = await teamtailorAdapter.fetchJobs(
    { provider: 'teamtailor', token: 'acme' },
    ctx({ items: [{
      id: 'ec153dc3', title: 'Backend Engineer',
      url: 'https://acme.teamtailor.com/jobs/7027594-backend-engineer',
      date_published: '2026-01-09T14:11:48+00:00',
      content_html: '<p>Go and Postgres.</p>',
      _jobposting: {
        employmentType: 'FULL_TIME',
        jobLocation: { address: { addressLocality: 'Cambridge', addressCountry: 'UK' } },
      },
    }] }),
  );
  const j = jobs[0]!;
  assert.equal(j.locationRaw, 'Cambridge, UK');
  assert.equal(j.employmentType, 'Full-time');
  assert.match(j.descriptionText!, /Go and Postgres/);
});

test('Teamtailor copes with an empty schema.org block', async () => {
  // The structured half is filled in to whatever degree the employer bothers;
  // an "Open Application" carries almost nothing.
  const jobs = await teamtailorAdapter.fetchJobs(
    { provider: 'teamtailor', token: 'a' },
    ctx({ items: [{ id: 'x', title: 'Open Application', url: 'https://a.teamtailor.com/jobs/1' }] }),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.locationRaw, undefined);
});

test('Teamtailor keys on the feed id, not the URL', async () => {
  // The URL carries a slug that changes whenever a title is edited, which would
  // make an edited posting look like a brand-new job every crawl.
  const jobs = await teamtailorAdapter.fetchJobs(
    { provider: 'teamtailor', token: 'a' },
    ctx({ items: [{ id: 'stable-uuid', title: 'Engineer', url: 'https://a.teamtailor.com/jobs/9-engineer' }] }),
  );
  assert.equal(jobs[0]!.externalId, 'stable-uuid');
});

test('the two newest providers are registered', () => {
  for (const p of ['recruitee', 'teamtailor'] as const) {
    assert.ok(SUPPORTED_PROVIDERS.includes(p), `${p} is not supported`);
    assert.equal(ADAPTERS[p].provider, p);
  }
});
