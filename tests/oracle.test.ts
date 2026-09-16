import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  oracleAdapter,
  oracleCompanyFrom,
  oracleCompanyFromPage,
  oracleJobUrl,
  oracleSearchUrl,
} from '../src/ats/adapters/oracle.js';
import { PATTERNS, toBoard } from '../src/discovery/commoncrawl.js';
import { resolveApplyUrl } from '../src/ats/resolve.js';
import { needsBackfill } from '../src/ats/describe.js';
import { canDescribe } from '../src/tailor/providers.js';
import type { FetchContext } from '../src/ats/types.js';

/**
 * Oracle Cloud Recruiting.
 *
 * The shapes here are real: every payload is trimmed from a live response on
 * 15 September 2026 (Pearson's tenant, `hccz`), because inventing a vendor's
 * JSON is how an adapter passes its tests and fails against the vendor.
 */

const ctx = (impl: typeof fetch): FetchContext => ({
  userAgent: 'test',
  timeoutMs: 5_000,
  fetchImpl: impl,
});

const board = { provider: 'oracle' as const, token: 'hccz', extra: { host: 'h.example', site: 'CX' } };

function page(total: number, ids: number[], org = 'Pearson') {
  return {
    items: [
      {
        TotalJobsCount: total,
        organizationsFacet: [{ Id: 1, Name: org, TotalCount: total }],
        requisitionList: ids.map((n) => ({
          Id: String(n),
          Title: `Engineer ${n}`,
          PostedDate: '2026-09-15',
          PrimaryLocation: 'Bangalore, Karnataka, India',
          PrimaryLocationCountry: 'IN',
          WorkplaceTypeCode: 'ORA_HYBRID',
          WorkplaceType: 'Hybrid',
          ShortDescriptionStr: '',
          secondaryLocations: [{ Name: 'Chennai, Tamil Nadu, India' }],
        })),
      },
    ],
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- paging

test('it keeps asking until the total is reached', async () => {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(String(url));
    const offset = Number(/offset%3D(\d+)/.exec(String(url))?.[1] ?? /offset=(\d+)/.exec(String(url))?.[1] ?? 0);
    const ids = Array.from({ length: Math.min(200, 450 - offset) }, (_, i) => offset + i);
    return json(page(450, ids));
  }) as unknown as typeof fetch;

  const jobs = await oracleAdapter.fetchJobs(board, ctx(impl));
  assert.equal(jobs.length, 450, 'stopped early — this is the bug that caps a board at one page');
  assert.equal(asked.length, 3, `expected 3 pages of 200, asked ${asked.length}`);
  assert.equal(new Set(jobs.map((j) => j.externalId)).size, 450, 'ids repeated across pages');
});

test('an empty page ends the loop rather than spinning', async () => {
  // A vendor that reports a total it cannot deliver is the classic infinite
  // paginator. MAX_PAGES would eventually stop it; an empty list must stop it
  // immediately.
  let calls = 0;
  const impl = (async () => {
    calls++;
    return json(page(10_000, calls === 1 ? [1, 2] : []));
  }) as unknown as typeof fetch;

  const jobs = await oracleAdapter.fetchJobs(board, ctx(impl));
  assert.equal(jobs.length, 2);
  assert.equal(calls, 2, 'should have stopped on the first empty page');
});

test('the page size asked for is the one the vendor will actually honour', () => {
  // Measured: asking for 300 returns 200. A limit above the cap makes the
  // offset arithmetic wrong and the paginator re-reads the same page forever.
  assert.match(oracleSearchUrl('h', 'CX', 200, 0), /limit%3D200/);
});

test('the offset advances by what came back, not by the page size', async () => {
  // A short page is normal at the end of a board. Advancing by PAGE_SIZE would
  // skip postings whenever a page came back short.
  const seen: number[] = [];
  const impl = (async (url: string) => {
    const offset = Number(/offset%3D(\d+)/.exec(String(url))![1]);
    seen.push(offset);
    // Deliberately short pages.
    const ids = offset < 30 ? [offset, offset + 1, offset + 2] : [];
    return json(page(30, ids));
  }) as unknown as typeof fetch;

  await oracleAdapter.fetchJobs(board, ctx(impl));
  assert.deepEqual(seen.slice(0, 4), [0, 3, 6, 9], 'offsets jumped — postings would be skipped');
});

// ---------------------------------------------------------------- normalising

test('a posting normalises with its date, location and apply url', async () => {
  const impl = (async () => json(page(1, [24881]))) as unknown as typeof fetch;
  const [job] = await oracleAdapter.fetchJobs(board, ctx(impl));
  assert.ok(job);
  assert.equal(job.externalId, '24881');
  assert.equal(job.title, 'Engineer 24881');
  assert.equal(job.country, 'IN');
  assert.equal(job.remoteType, 'hybrid');
  assert.equal(job.postedAt?.toISOString().slice(0, 10), '2026-09-15');
  assert.equal(job.applyUrl, 'https://h.example/hcmUI/CandidateExperience/en/sites/CX/job/24881');
});

test('a posting with no title or no id is dropped, not stored half-formed', async () => {
  const impl = (async () =>
    json({
      items: [
        {
          TotalJobsCount: 3,
          requisitionList: [
            { Id: '1', Title: '  ' },
            { Title: 'No id here' },
            { Id: '3', Title: 'Real one' },
          ],
        },
      ],
    })) as unknown as typeof fetch;
  const jobs = await oracleAdapter.fetchJobs(board, ctx(impl));
  assert.deepEqual(jobs.map((j) => j.title), ['Real one']);
});

test('a board missing its host or site refuses loudly instead of 404ing weekly', async () => {
  const impl = (async () => json(page(1, [1]))) as unknown as typeof fetch;
  await assert.rejects(
    () => oracleAdapter.fetchJobs({ provider: 'oracle', token: 't', extra: { site: 'CX' } }, ctx(impl)),
    /needs extra\.host and extra\.site/,
  );
});

test('the workplace code decides remoteness, and an unknown code falls back', async () => {
  const withCode = async (code: string, location: string) => {
    const impl = (async () =>
      json({
        items: [
          {
            TotalJobsCount: 1,
            requisitionList: [
              { Id: '1', Title: 'Engineer', WorkplaceTypeCode: code, PrimaryLocation: location },
            ],
          },
        ],
      })) as unknown as typeof fetch;
    const [j] = await oracleAdapter.fetchJobs(board, ctx(impl));
    return j?.remoteType;
  };
  assert.equal(await withCode('ORA_REMOTE', 'London, United Kingdom'), 'fully_remote');
  assert.equal(await withCode('ORA_ONSITE', 'London, United Kingdom'), 'on_site');
  // A code Oracle has not shipped yet must not silently become on-site-by-code;
  // it falls through to the shared inference over the location.
  assert.equal(await withCode('ORA_SOMETHING_NEW', 'London, United Kingdom'), 'on_site');
});

// ---------------------------------------------------------------- the name

test('the employer name comes from the facet, since the token is a code', () => {
  assert.equal(oracleCompanyFrom(page(10, [1])), 'Pearson');
  assert.equal(oracleCompanyFrom({ items: [{ requisitionList: [] }] }), undefined);
  assert.equal(oracleCompanyFrom(null), undefined);
});

test('a tenant listing its subsidiaries is named after the parent', () => {
  // This is the case the first version of the code refused to name, and
  // refusing is what put "Eofh" in the registry instead of "Tata Capital". The
  // facet is ordered by posting count, so the parent is first in every tenant
  // checked against the live vendor.
  const body = {
    items: [
      {
        organizationsFacet: [
          { Name: 'Tata Capital Limited', TotalCount: 3000 },
          { Name: 'Tata Capital Housing Finance Limited', TotalCount: 900 },
          { Name: 'Tata Securities Limited', TotalCount: 200 },
        ],
        requisitionList: [],
      },
    ],
  };
  assert.equal(oracleCompanyFrom(body), 'Tata Capital Limited');
});

test('the page title beats the facet, and Oracle’s template is stripped from it', () => {
  // Real titles, all four read from live career sites on 16 September 2026.
  assert.equal(oracleCompanyFromPage('<title>Tata Capital</title>'), 'Tata Capital');
  assert.equal(oracleCompanyFromPage('<title>Lifepoint Health</title>'), 'Lifepoint Health');
  assert.equal(oracleCompanyFromPage('<title>Pearson Candidate Experience Site</title>'), 'Pearson');
  assert.equal(oracleCompanyFromPage('<title>IHG Career</title>'), 'IHG');
});

test('a site left on the stock template names nobody, so the facet answers', () => {
  // hcbt's title is exactly this, and its facet says Kotak Mahindra Bank Ltd.
  // Returning "Candidate Experience" here would be worse than returning the
  // tenant code, because it looks like a real employer.
  assert.equal(oracleCompanyFromPage('<title>Candidate Experience site</title>'), undefined);
  assert.equal(oracleCompanyFromPage('<title>Careers</title>'), undefined);
  assert.equal(oracleCompanyFromPage('<title>   </title>'), undefined);
  assert.equal(oracleCompanyFromPage('<html><head></head></html>'), undefined);
});

test('a real name that merely contains a job word survives', () => {
  // Only trailing template phrases are stripped. An employer whose name ends in
  // a job-shaped word keeps it if that is all there is.
  assert.equal(oracleCompanyFromPage('<title>Career Education Corporation</title>'), 'Career Education Corporation');
  assert.equal(oracleCompanyFromPage('<title>WSP</title>'), 'WSP');
});

test('an entity in the title is decoded, not shown raw', () => {
  assert.equal(oracleCompanyFromPage('<title>Johnson &amp; Johnson Careers</title>'), 'Johnson & Johnson');
});

test('an error page served with HTTP 200 is not an employer', () => {
  // Two Oracle career sites answer 200 with an error page, and the first repair
  // run was about to write "Page not found" into the registry as a company —
  // over two rows that already had real names. A 200 is not proof of a page,
  // exactly as a 200 is not proof of a board elsewhere in this codebase.
  for (const t of ['Page not found', 'page not found.', 'Error', '404', 'Access Denied', 'Loading', 'Sign in']) {
    assert.equal(oracleCompanyFromPage(`<title>${t}</title>`), undefined, t);
  }
});

test('a title carrying javascript escaping is decoded', () => {
  // These titles are injected by Oracle's own single-page app and some arrive
  // with the bundle's escaping still on them. Both real, from the first repair
  // run: without this, one employer is stored with a stray backslash and the
  // other with a literal í where the í belongs.
  assert.equal(oracleCompanyFromPage("<title>Chili\\'s</title>"), "Chili's");
  assert.equal(
    oracleCompanyFromPage('<title>Bolsa de Trabajo Taj\\u00EDn</title>'),
    'Bolsa de Trabajo Tajín',
  );
  assert.equal(oracleCompanyFromPage('<title>Ben &#x26; Jerry&#39;s</title>'), "Ben & Jerry's");
});

test('a site descriptor is stripped, and a bare one names nobody', () => {
  // All from the first repair run, where they would have been stored as the
  // employer: a career site's name is not a company's name.
  assert.equal(oracleCompanyFromPage('<title>WTW External</title>'), 'WTW');
  assert.equal(oracleCompanyFromPage('<title>AICC External Site</title>'), 'AICC');
  assert.equal(oracleCompanyFromPage('<title>Linamar Career Site - New</title>'), 'Linamar');
  assert.equal(oracleCompanyFromPage('<title>daa All Open Jobs</title>'), 'daa');
  assert.equal(oracleCompanyFromPage('<title>Our vacancies</title>'), undefined);
  assert.equal(oracleCompanyFromPage('<title>Jobs and</title>'), undefined);
});

test('a name the employer puts after a lead-in is still found', () => {
  assert.equal(oracleCompanyFromPage('<title>Careers at WorkplaceNL</title>'), 'WorkplaceNL');
  assert.equal(oracleCompanyFromPage('<title>Jobs at Arcadis</title>'), 'Arcadis');
});

test('the repair only ever replaces the tenant placeholder', () => {
  // A repair that can overwrite a good value is not a repair. The only row it
  // touches is one still carrying the title-cased tenant code.
  const src = readFileSync(new URL('../src/cli/oracle-names.ts', import.meta.url), 'utf8');
  assert.match(src, /function isPlaceholder/);
  assert.match(src, /return isPlaceholder\(current, token\);/);
  // And it must never reach for anything but the name.
  assert.ok(!/\.delete\(\)|active:\s*false/.test(src), 'the repair can deactivate a board');
  assert.match(src, /\.update\(\{ company: w\.company \}\)/);
});

test('verification prefers the page title and falls back to the facet', () => {
  const src = readFileSync(new URL('../src/discovery/verify.ts', import.meta.url), 'utf8');
  assert.match(src, /oracleTitle\([^)]*\)\) \?\? oracleCompanyFrom\(body\)/);
});

// ---------------------------------------------------------------- discovery

const oraclePattern = () => {
  const p = PATTERNS.find((x) => x.provider === 'oracle');
  assert.ok(p, 'the oracle pattern is gone from commoncrawl.ts');
  return p;
};

test('the oracle pattern reads the host and the site out of a real board url', () => {
  const p = oraclePattern();
  const b = toBoard(p, 'https://hccz.fa.em3.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/24881');
  assert.equal(b?.token, 'hccz');
  assert.equal(b?.extra?.host, 'hccz.fa.em3.oraclecloud.com');
  assert.equal(b?.extra?.site, 'CX');
});

test('the oracle pattern handles the site shapes seen in the index', () => {
  const p = oraclePattern();
  const cases: [string, string][] = [
    ['https://edox.fa.ap1.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001/job/16710', 'CX_3001'],
    ['https://ehjd.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/fabCareers/job/1', 'fabCareers'],
    ['https://cbct.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en_GB/sites/gallifordtrycareers/job/2', 'gallifordtrycareers'],
  ];
  for (const [url, site] of cases) {
    assert.equal(toBoard(p, url)?.extra?.site, site, url);
  }
});

test('oracle’s own infrastructure is never read as a career board', () => {
  // oraclecloud.com is mostly object storage, IaaS endpoints and status pages —
  // 14,565 urls on one index page, of which the career boards were a subset.
  // Without the path check the harvest registers "objectstorage" as an employer.
  const p = oraclePattern();
  for (const url of [
    'https://objectstorage.ap-melbourne-1.oraclecloud.com/n/x/b/seo/o/page.html',
    'https://iaas.ap-mumbai-1.oraclecloud.com/robots.txt',
    'https://ams.oraclecloud.com/ams/login',
    'https://aconex-status.oraclecloud.com/',
  ]) {
    assert.equal(toBoard(p, url), null, url);
  }
});

test('an oracle apply url resolves back to the board it came from', () => {
  const r = resolveApplyUrl(oracleJobUrl('hccz.fa.em3.oraclecloud.com', 'CX', '24881'));
  assert.equal(r.status, 'supported');
  if (r.status !== 'supported') return;
  assert.equal(r.board.provider, 'oracle');
  assert.equal(r.board.token, 'hccz');
  assert.equal(r.board.extra?.site, 'CX');
  assert.equal(r.board.extra?.host, 'hccz.fa.em3.oraclecloud.com');
});

test('a non-recruiting oracle host is still classified, not resolved', () => {
  const r = resolveApplyUrl('https://objectstorage.ap-mumbai-1.oraclecloud.com/n/x/b/y/o/z.html');
  assert.equal(r.status, 'unsupported');
});

// ---------------------------------------------------------------- wiring

test('oracle is wired for descriptions in both places that decide it', () => {
  // The listing carries an empty ShortDescriptionStr and null description
  // fields, so without the backfill every Oracle posting reaches scoring with
  // nothing to match a resume against — and the feed would offer a tailor
  // button that can only ever fail.
  assert.equal(needsBackfill('oracle'), true);
  assert.equal(canDescribe('oracle'), true);
});
