import { test } from 'node:test';
import assert from 'node:assert/strict';

import { amazonAdapter, amazonListUrl, AMAZON_PAGE } from '../src/ats/adapters/amazon.js';
import { needsBackfill } from '../src/ats/describe.js';
import { inferUsState } from '../src/ats/geo.js';
import type { FetchContext } from '../src/ats/types.js';

/**
 * Amazon. Shapes trimmed from live search.json responses (10 October 2026).
 *
 * The three things worth locking: it pages at 100 and must not stop after the
 * first page; the state filter is loose, so a WA board must drop the CA/NY rows
 * the API mixes in; and the clean normalized_location it carries is what the
 * central region inference reads.
 */

const ctx = (impl: typeof fetch, maxJobs?: number): FetchContext => ({
  userAgent: 'test',
  timeoutMs: 5_000,
  fetchImpl: impl,
  ...(maxJobs !== undefined ? { maxJobs } : {}),
});

const waBoard = {
  provider: 'amazon' as const,
  token: 'us-wa',
  extra: { stateName: 'Washington', state: 'WA', country: 'USA' },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const mkJob = (n: number, state: string, over: Record<string, unknown> = {}) => ({
  id: 10_500_000 + n,
  title: `Software Development Engineer ${n}`,
  normalized_location: state === 'WA' ? 'Seattle, Washington, USA' : 'San Francisco, California, USA',
  location: state === 'WA' ? 'US, WA, Seattle' : 'US, CA, San Francisco',
  city: state === 'WA' ? 'Seattle' : 'San Francisco',
  state,
  posted_date: 'October  9, 2026',
  job_path: `/en/jobs/${10_500_000 + n}/software-development-engineer`,
  description: '<p>Build systems at scale.</p>',
  basic_qualifications: '<p>3+ years of experience</p>',
  preferred_qualifications: '<p>AWS experience</p>',
  business_category: 'aws',
  is_intern: false,
  ...over,
});

/**
 * A fake WA board that, like the real one, serves 100 a page by offset and mixes
 * primary-CA rows into a `normalized_state_name=Washington` query.
 */
function amazonBoard(waJobs: ReturnType<typeof mkJob>[], caJobs: ReturnType<typeof mkJob>[] = []) {
  const jobs = [...waJobs, ...caJobs];
  const pages: string[] = [];
  const impl = (async (url: string) => {
    const u = new URL(String(url));
    const offset = Number(u.searchParams.get('offset') ?? '0');
    const limit = Number(u.searchParams.get('result_limit') ?? '100');
    pages.push(String(url));
    return json({ hits: jobs.length, jobs: jobs.slice(offset, offset + limit) });
  }) as unknown as typeof fetch;
  return { impl, pages };
}

test('the list URL carries country, state, recency and paging as the API wants them', () => {
  const url = new URL(amazonListUrl('Washington', 'USA', 200, AMAZON_PAGE));
  assert.equal(url.pathname, '/en/search.json');
  assert.deepEqual(url.searchParams.getAll('normalized_country_code[]'), ['USA']);
  assert.deepEqual(url.searchParams.getAll('normalized_state_name[]'), ['Washington']);
  assert.equal(url.searchParams.get('sort'), 'recent');
  assert.equal(url.searchParams.get('offset'), '200');
  assert.equal(url.searchParams.get('result_limit'), '100');
});

test('pages past the first page and keeps only the primary-state rows', async () => {
  const wa = Array.from({ length: 250 }, (_, i) => mkJob(i, 'WA'));
  const ca = Array.from({ length: 40 }, (_, i) => mkJob(1000 + i, 'CA'));
  const { impl, pages } = amazonBoard(wa, ca);

  const jobs = await amazonAdapter.fetchJobs(waBoard, ctx(impl));

  // All 250 WA kept, every CA row dropped — the loose state filter cleaned up.
  assert.equal(jobs.length, 250);
  assert.ok(jobs.every((j) => j.locationRaw === 'Seattle, Washington, USA'));
  // Read more than one page: 290 rows at 100 a page is three requests.
  assert.equal(pages.length, 3);
  // No posting counted twice.
  assert.equal(new Set(jobs.map((j) => j.externalId)).size, 250);
});

test('maps the fields the site needs, from the inline payload', async () => {
  const { impl } = amazonBoard([mkJob(0, 'WA')]);
  const [job] = await amazonAdapter.fetchJobs(waBoard, ctx(impl));
  assert.ok(job);
  assert.equal(job.externalId, '10500000');
  assert.equal(job.title, 'Software Development Engineer 0');
  assert.equal(job.locationRaw, 'Seattle, Washington, USA');
  assert.equal(job.applyUrl, 'https://www.amazon.jobs/en/jobs/10500000/software-development-engineer');
  assert.equal(job.listingUrl, job.applyUrl);
  assert.equal(job.department, 'aws');
  // "October  9, 2026" (double space) parses to the right day.
  assert.equal(job.postedAt?.toISOString().slice(0, 10), '2026-10-09');
  // The inline description plus both qualification blocks become the text.
  assert.match(job.descriptionText ?? '', /Build systems at scale/);
  assert.match(job.descriptionText ?? '', /Basic qualifications/);
  assert.match(job.descriptionText ?? '', /AWS experience/);
});

test('seniority reads the intern flag and then the title', async () => {
  const { impl } = amazonBoard([
    mkJob(0, 'WA', { is_intern: true, title: 'Software Dev Engineer Intern' }),
    mkJob(1, 'WA', { title: 'Senior Software Development Engineer' }),
  ]);
  const jobs = await amazonAdapter.fetchJobs(waBoard, ctx(impl));
  assert.equal(jobs[0]?.seniority, 'entry');
  assert.equal(jobs[1]?.seniority, 'senior');
});

test('ctx.maxJobs bounds an enterprise board to the crawl budget', async () => {
  const wa = Array.from({ length: 250 }, (_, i) => mkJob(i, 'WA'));
  const { impl } = amazonBoard(wa);
  const jobs = await amazonAdapter.fetchJobs(waBoard, ctx(impl, 150));
  assert.equal(jobs.length, 150);
});

test('a board with no state scope is refused, not crawled blindly', async () => {
  const { impl } = amazonBoard([mkJob(0, 'WA')]);
  await assert.rejects(
    () => amazonAdapter.fetchJobs({ provider: 'amazon', token: 'us-wa' }, ctx(impl)),
    /needs extra\.stateName/,
  );
});

test('Amazon is self-sufficient: its listing already holds the description', () => {
  assert.equal(needsBackfill('amazon'), false);
});

test('the location it stores resolves to the state the page filters on', () => {
  // Ties the adapter to the Washington page: the clean normalized_location it
  // sets is exactly what inferUsState reads to fill the region column.
  assert.equal(inferUsState('Seattle, Washington, USA'), 'WA');
  assert.equal(inferUsState('Washington, District of Columbia, USA'), 'DC');
});
