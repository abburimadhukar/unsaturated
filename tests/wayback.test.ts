import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PATTERNS, toBoard } from '../src/discovery/commoncrawl.js';
import { defaultFrom, waybackQuery } from '../src/discovery/wayback.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * The second index, and Workday's second address.
 *
 * Both are about the same failure: an index that answers 200 with nothing,
 * which reads identically to a vendor that has no boards.
 */

// ------------------------------------------------- translating the patterns

test('a host pattern asks for a prefix and a subdomain pattern uses the Archive wildcard', () => {
  assert.deepEqual(waybackQuery('job-boards.greenhouse.io/*'), {
    url: 'job-boards.greenhouse.io',
    matchType: 'prefix',
  });
  assert.deepEqual(waybackQuery('*.recruitee.com/*'), { url: '*.recruitee.com' });
  assert.deepEqual(waybackQuery('ats.rippling.com/*'), {
    url: 'ats.rippling.com',
    matchType: 'prefix',
  });
});

test('a prefix query never carries a trailing star as well', () => {
  // Measured against the live API: `url=jobs.ashbyhq.com*&matchType=prefix`
  // returns ZERO rows; `url=jobs.ashbyhq.com&matchType=prefix` returns 37,656.
  // Zero is also what a robots-excluded host returns, so this mistake reads as
  // "Ashby is not in the Archive" rather than as a broken query — which is
  // exactly how it got shipped once.
  for (const p of PATTERNS) {
    const q = waybackQuery(p.match);
    assert.ok(
      !(q.matchType && q.url.endsWith('*')),
      `${p.match} -> ${q.url} would match nothing at all`,
    );
  }
});

test('every harvest pattern translates to a bare host query', () => {
  // A leftover '/*' is Common Crawl syntax the Archive does not speak.
  for (const p of PATTERNS) {
    const q = waybackQuery(p.match);
    assert.ok(!q.url.includes('/'), `${p.match} -> ${q.url} still has a path`);
    assert.ok(q.url.length > 0, `${p.match} translated to nothing`);
  }
});

test('the row limit stays above the floor that collapsing needs', () => {
  // The Archive applies `limit` before `collapse=urlkey`, and rows are sorted
  // by urlkey — so a low limit reads thousands of near-identical urls from a
  // handful of boards. Ashby at limit=4,000 collapses to 7 distinct urls; at
  // 150,000 it is 37,656. A "gentler" limit silently discards the discovery.
  const wb = read('../src/discovery/wayback.ts');
  assert.match(wb, /MIN_LIMIT = 100_000/);
  assert.match(wb, /Math\.max\(MIN_LIMIT/);
});

test('the default window is recent, because old captures verified at 5% and no jobs', () => {
  // Sixty tokens from a two-year-old Common Crawl snapshot: three answered, and
  // those three had zero open postings between them.
  const from = defaultFrom(new Date('2026-09-15T00:00:00Z'));
  assert.equal(from, '20260615');
  assert.match(from, /^\d{8}$/);
});

test('the two indexes share one pattern table', () => {
  // Two lists would drift, and a vendor found by one and not the other is
  // exactly the silent gap this whole module exists to close.
  const wb = read('../src/discovery/wayback.ts');
  assert.match(wb, /from '\.\/commoncrawl\.js'/);
  assert.ok(!/match: '/.test(wb), 'wayback.ts has grown its own pattern list');
});

// ------------------------------------------------- junk in the candidate list

test('an application route is not mistaken for a company board', () => {
  const ashby = PATTERNS.find((p) => p.provider === 'ashby')!;
  // Both seen in one live Ashby harvest on 15 September 2026.
  assert.equal(toBoard(ashby, 'https://jobs.ashbyhq.com/51f67855-3ba7-445a-99bb-97e9f5093e4b'), null);
  assert.equal(toBoard(ashby, `https://jobs.ashbyhq.com/${'A'.repeat(400)}`), null);
});

test('a real board carrying a uuid in its name survives', () => {
  // ashby:jobs-page-4dc2685b-eb82-46d1-a3f9-1f0764dba814 is a live board with
  // 54 postings. An unanchored uuid test would have discarded it.
  const ashby = PATTERNS.find((p) => p.provider === 'ashby')!;
  const b = toBoard(ashby, 'https://jobs.ashbyhq.com/jobs-page-4dc2685b-eb82-46d1-a3f9-1f0764dba814');
  assert.equal(b?.token, 'jobs-page-4dc2685b-eb82-46d1-a3f9-1f0764dba814');
});

test('the longest real token in the registry still passes', () => {
  // 73 characters, a US county attorney's office on SmartRecruiters. The cap
  // exists to catch signed tokens, not long employer names.
  const sr = PATTERNS.find((p) => p.provider === 'smartrecruiters')!;
  const token = 'OfficeOfTheCommonwealthsAttorneyForArlingtonCountyAndTheCityOfFallsChurch';
  assert.equal(toBoard(sr, `https://jobs.smartrecruiters.com/${token}`)?.token, token);
});

// ------------------------------------------------- workday's second address

const siteOnlyPattern = () => {
  const p = PATTERNS.find((x) => x.provider === 'workday' && x.match.includes('myworkdaysite'));
  assert.ok(p, 'the myworkdaysite pattern is gone');
  return p;
};

test('a myworkdaysite url yields a tenant and a site', () => {
  const p = siteOnlyPattern();
  const cases: [string, string, string][] = [
    ['https://wd1.myworkdaysite.com/en-US/recruiting/abinbev/SAB/job/x', 'abinbev', 'SAB'],
    ['https://wd1.myworkdaysite.com/de-DE/recruiting/whitecase/External/job/x', 'whitecase', 'External'],
    ['https://wd1.myworkdaysite.com/recruiting/clorox/Clorox/job/x', 'clorox', 'Clorox'],
    ['https://wd5.myworkdaysite.com/en-US/recruiting/scu/scupostings/4833', 'scu', 'scupostings'],
  ];
  for (const [url, token, site] of cases) {
    const b = toBoard(p, url);
    assert.equal(b?.token, token, url);
    assert.equal(b?.extra?.site, site, url);
  }
});

test('NO host is recorded, because the one in the address is not the tenant’s shard', () => {
  // Measured 15 Sep 2026: of eight tenants found only on myworkdaysite, three
  // answered on wd3 and wd12 rather than the wd1 in their address. Recording
  // that hostname would have written three live employers off as dead.
  const b = toBoard(siteOnlyPattern(), 'https://wd1.myworkdaysite.com/en-US/recruiting/bsigroup/BSI_Careers/job/x');
  assert.equal(b?.extra?.host, undefined);
  assert.equal(b?.extra?.site, 'BSI_Careers');
});

test('a myworkdaysite url with no tenant segment yields nothing', () => {
  // Link rot: plenty of archived urls lost the /recruiting/{tenant} half. A
  // board built from one of those has a site and no tenant and can never be
  // fetched.
  const p = siteOnlyPattern();
  assert.equal(toBoard(p, 'https://wd1.myworkdaysite.com/en-US/Clorox/job/x'), null);
  assert.equal(toBoard(p, 'https://wd1.myworkdaysite.com/EUR/job/x'), null);
});

test('the first domain still records its shard, and the two do not collide', () => {
  const primary = PATTERNS.find((x) => x.provider === 'workday' && x.match.includes('myworkdayjobs'));
  assert.ok(primary);
  const b = toBoard(primary, 'https://fmr.wd1.myworkdayjobs.com/en-US/FidelityCareers/job/x');
  assert.equal(b?.token, 'fmr');
  assert.equal(b?.extra?.host, 'fmr.wd1.myworkdayjobs.com');
  // And the second pattern must not match a myworkdayjobs url at all, or one
  // board would be harvested twice under two shapes.
  assert.equal(toBoard(siteOnlyPattern(), 'https://fmr.wd1.myworkdayjobs.com/en-US/FidelityCareers/job/x'), null);
});

test('verification resolves the shard before deciding a tenant is dead', () => {
  // Without this the board has no host, endpoint() returns null, the verdict is
  // "unknown", and only "live" boards are stored — so every tenant found on the
  // second domain would be harvested, discarded and reported as a success.
  const verify = read('../src/discovery/verify.ts');
  assert.match(verify, /resolveBeforeCheck/);
  assert.match(verify, /discoverWorkdaySite\(/);
});

test('what verification worked out is what gets stored', () => {
  // The resolved shard and the real employer name have to survive into the
  // upsert, or the stored row is the half-formed one that could not be checked.
  for (const cli of ['../src/cli/harvest-cc.ts', '../src/cli/harvest-ia.ts']) {
    const src = read(cli);
    assert.match(src, /company: r\.company \?\? r\.board\.company/, cli);
    assert.match(src, /extra: r\.extra \?\? r\.board\.extra/, cli);
  }
});

// ------------------------------------------------- the workflow

test('the Archive harvest runs in the weekly job, not just in the code', () => {
  // A harvester nobody schedules is a harvester that never runs. Rippling sat
  // with a working adapter and no matrix line for months for exactly this
  // reason.
  const wf = read('../.github/workflows/discover.yml');
  assert.match(wf, /npm run harvest:ia/);
  assert.match(wf, /--provider \$\{\{ matrix\.provider \}\}/);
});

test('the job has time for two verification passes, not one', () => {
  // Each harvest verifies up to 3,000 boards at one request a second — 50
  // minutes — and the greenhouse shard also carries the 600-board
  // re-verification. A ceiling sized for a single pass kills a run part-way
  // through writing, which leaves the registry holding a partial harvest with
  // no record of where it stopped.
  const wf = read('../.github/workflows/discover.yml');
  const timeout = Number(/timeout-minutes: (\d+)/.exec(wf)?.[1] ?? 0);
  assert.ok(timeout >= 150, `timeout-minutes is ${timeout}, too tight for two verification passes`);
});

test('a failing Archive cannot take the Common Crawl harvest red with it', () => {
  // The Archive goes offline. If that failed the job, the Common Crawl step
  // that ran successfully above it would be reported as a failed run — and a
  // failure signal that fires most weeks is one nobody reads.
  const wf = read('../.github/workflows/discover.yml');
  const step = wf.slice(wf.indexOf('Harvest new boards from the Internet Archive'));
  assert.match(step.slice(0, 400), /continue-on-error: true/);
});

test('a pattern the Archive cannot serve is skipped with its reason, not retried', () => {
  // oraclecloud.com is one of the largest domains on the internet and the
  // Archive 504s trying to collapse it — measured, after 61 seconds, three
  // times. Retrying that weekly costs minutes and finds nothing; Oracle comes
  // from Common Crawl, which pages by block.
  const wb = read('../src/discovery/wayback.ts');
  assert.match(wb, /UNAVAILABLE/);
  assert.match(wb, /'\*\.oraclecloud\.com\/\*'/);
  assert.match(wb, /504 after 61s/);
});

test('the two harvests agree on what makes a board distinct', () => {
  // Keyed without the site, one Oracle tenant collapses to a single career site
  // and the rest are dropped as duplicates — which is what the 2026-09-07
  // migration was written to stop happening to Workday.
  for (const cli of ['../src/cli/harvest-cc.ts', '../src/cli/harvest-ia.ts']) {
    assert.match(
      read(cli),
      /\$\{b\.provider\}:\$\{b\.token\.toLowerCase\(\)\}:\$\{\(b\.extra\?\.site \?\? ''\)\.toLowerCase\(\)\}/,
      cli,
    );
  }
});
