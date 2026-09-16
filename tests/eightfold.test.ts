import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EIGHTFOLD_PAGE,
  eightfoldAdapter,
  eightfoldCompanyFrom,
  eightfoldListUrl,
} from '../src/ats/adapters/eightfold.js';
import { fetchDetail, needsBackfill } from '../src/ats/describe.js';
import { resolveApplyUrl } from '../src/ats/resolve.js';
import { canDescribe } from '../src/tailor/providers.js';
import { PATTERNS, toBoard } from '../src/discovery/commoncrawl.js';
import type { FetchContext } from '../src/ats/types.js';

/**
 * Eightfold. Shapes trimmed from live responses (Bayer, 16 September 2026).
 */

const ctx = (impl: typeof fetch): FetchContext => ({ userAgent: 'test', timeoutMs: 5_000, fetchImpl: impl });
const board = { provider: 'eightfold' as const, token: 'bayer', extra: { domain: 'bayer.com', site: 'bayer.com' } };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const position = (n: number) => ({
  id: 562949978500000 + n,
  name: `Engineer ${n}`,
  location: 'Columbus,Ohio,United States',
  locations: ['Columbus,Ohio,United States'],
  department: 'Information Technology',
  t_create: 1789084800,
  canonicalPositionUrl: `https://talent.bayer.com/careers/job/${562949978500000 + n}`,
  work_location_option: 'onsite',
  job_description: '',
});

/** A fake board of `total` postings that, like the real one, returns ten a page whatever is asked. */
function board10(total: number) {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(String(url));
    const start = Number(new URL(String(url)).searchParams.get('start') ?? 0);
    const n = Math.max(0, Math.min(EIGHTFOLD_PAGE, total - start));
    return json({
      count: total,
      branding: { companyName: 'Bayer' },
      positions: Array.from({ length: n }, (_, i) => position(start + i)),
    });
  }) as unknown as typeof fetch;
  return { impl, asked };
}

// ------------------------------------------------------------------ paging

test('it reads every page, although the vendor caps a page at ten', async () => {
  const { impl, asked } = board10(601);
  const jobs = await eightfoldAdapter.fetchJobs(board, ctx(impl));
  assert.equal(jobs.length, 601, 'a paginator trusting the size it asked for stops at ten');
  assert.equal(asked.length, 61);
  assert.equal(new Set(jobs.map((j) => j.externalId)).size, 601);
});

test('the crawl cap stops it early, so a big board cannot hold a shard', async () => {
  const { impl, asked } = board10(601);
  const jobs = await eightfoldAdapter.fetchJobs(board, { ...ctx(impl), maxJobs: 300 });
  assert.equal(jobs.length, 300);
  assert.equal(asked.length, 30);
});

test('a page of nothing but repeats ends the loop', async () => {
  // A vendor ignoring `start` would otherwise be read two hundred times.
  let calls = 0;
  const impl = (async () => {
    calls++;
    return json({ count: 500, positions: [position(1), position(2)] });
  }) as unknown as typeof fetch;
  const jobs = await eightfoldAdapter.fetchJobs(board, ctx(impl));
  assert.equal(jobs.length, 2);
  assert.equal(calls, 2);
});

test('pages are asked for newest first', () => {
  // The crawl keeps 300 a board. Without the sort, the default order dropped a
  // Bayer posting three days newer than anything on its first page.
  assert.match(eightfoldListUrl('bayer', 'bayer.com', 0, 10), /[?&]sort_by=new(&|$)/);
  assert.match(eightfoldListUrl('bayer', 'bayer.com', 0, 10), /[?&]domain=bayer\.com(&|$)/);
});

// ------------------------------------------------------------------ normalising

test('a posting normalises with its date, workplace and the employer’s own url', async () => {
  const { impl } = board10(1);
  const [j] = await eightfoldAdapter.fetchJobs(board, ctx(impl));
  assert.ok(j);
  // Epoch seconds: forgetting to multiply dates everything to January 1970.
  assert.equal(j.postedAt?.toISOString().slice(0, 10), '2026-09-11');
  assert.equal(j.remoteType, 'on_site');
  assert.equal(j.department, 'Information Technology');
  assert.equal(j.applyUrl, 'https://talent.bayer.com/careers/job/562949978500000');
});

test('remote and hybrid come from the vendor field, not the location', async () => {
  const one = async (option: string) => {
    const impl = (async () =>
      json({ count: 1, positions: [{ ...position(1), work_location_option: option, location: 'London, United Kingdom' }] })) as unknown as typeof fetch;
    return (await eightfoldAdapter.fetchJobs(board, ctx(impl)))[0]?.remoteType;
  };
  assert.equal(await one('remote'), 'fully_remote');
  assert.equal(await one('hybrid'), 'hybrid');
});

test('a posting with no url of its own links to Eightfold, with the domain', async () => {
  const impl = (async () =>
    json({ count: 1, positions: [{ ...position(1), canonicalPositionUrl: '' }] })) as unknown as typeof fetch;
  const [j] = await eightfoldAdapter.fetchJobs(board, ctx(impl));
  assert.equal(j?.applyUrl, 'https://bayer.eightfold.ai/careers/job/562949978500001?domain=bayer.com');
});

test('a board with no domain refuses rather than asking a question that 404s', async () => {
  const { impl } = board10(1);
  await assert.rejects(
    () => eightfoldAdapter.fetchJobs({ provider: 'eightfold', token: 'bayer' }, ctx(impl)),
    /needs extra\.domain/,
  );
});

test('a gated tenant is a refusal, never a board that is gone', async () => {
  // 403 {"message": "Not authorized for PCSX"} — amgen and eaton, measured.
  const impl = (async () => json({ message: 'Not authorized for PCSX' }, 403)) as unknown as typeof fetch;
  await assert.rejects(
    () => eightfoldAdapter.fetchJobs(board, ctx(impl)),
    (err: { failure?: string }) => err.failure === 'refused',
  );
});

test('the employer name comes from branding', () => {
  assert.equal(eightfoldCompanyFrom({ branding: { companyName: 'Bayer' } }), 'Bayer');
  assert.equal(eightfoldCompanyFrom({ branding: { companyName: '  ' } }), undefined);
  assert.equal(eightfoldCompanyFrom(null), undefined);
});

// ------------------------------------------------------------------ descriptions

test('the description comes from the per-posting endpoint', async () => {
  assert.equal(needsBackfill('eightfold'), true);
  assert.equal(canDescribe('eightfold'), true);
  let asked = '';
  const impl = (async (url: string) => {
    asked = String(url);
    return json({ job_description: '<p>At Bayer we are <b>visionaries</b></p>', t_create: 1789084800 });
  }) as unknown as typeof fetch;
  const detail = await fetchDetail(
    board,
    { externalId: '562949978524785', title: 'x', raw: {} },
    { userAgent: 't', timeoutMs: 5_000, fetchImpl: impl },
  );
  assert.match(asked, /\/api\/apply\/v2\/jobs\/562949978524785\?domain=bayer\.com$/);
  assert.match(detail?.description ?? '', /At Bayer we are visionaries/);
});

// ------------------------------------------------------------------ discovery

const pattern = () => {
  const p = PATTERNS.find((x) => x.provider === 'eightfold');
  assert.ok(p, 'the eightfold pattern is gone');
  return p;
};

test('the pattern reads the tenant and the domain from a real archived url', () => {
  const b = toBoard(
    pattern(),
    'https://albemarle.eightfold.ai/careers/job/1099540838895-lubrication-technician?domain=albemarle.com&microsite=albemarle.com',
  );
  assert.equal(b?.token, 'albemarle');
  assert.equal(b?.extra?.domain, 'albemarle.com');
  assert.equal(b?.extra?.site, 'albemarle.com');
});

test('the domain is found wherever it sits in the query', () => {
  const b = toBoard(pattern(), 'https://bcg.eightfold.ai/careers?query=x&domain=bcg.com&pid=1');
  assert.equal(b?.extra?.domain, 'bcg.com');
});

test('a url with no domain is not a board, because a domain cannot be guessed', () => {
  assert.equal(toBoard(pattern(), 'https://bayer.eightfold.ai/careers/job/1'), null);
});

test('eightfold’s own hosts and customers’ test copies are never stored', () => {
  for (const url of [
    'https://www.eightfold.ai/careers?domain=eightfold.ai',
    'https://app.eightfold.ai/careers?domain=eightfold.ai',
    'https://aexp-sandbox.eightfold.ai/careers?domain=aexp-sandbox.com',
    'https://libertymutual.eightfold.ai/careers?domain=libertymutual-sandbox.com',
    'https://hp.eightfold.ai/careers?domain=hp-staging.com',
  ]) {
    assert.equal(toBoard(pattern(), url), null, url);
  }
});

test('an eightfold link with a domain resolves to a board', () => {
  const r = resolveApplyUrl('https://bayer.eightfold.ai/careers/job/562949978524785?domain=bayer.com');
  assert.equal(r.status, 'supported');
  if (r.status !== 'supported') return;
  assert.equal(r.board.token, 'bayer');
  assert.equal(r.board.extra?.domain, 'bayer.com');
});
