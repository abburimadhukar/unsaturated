import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DATASET_FILES, parseCsv, rowToBoard } from '../src/discovery/datasets.js';
import type { AtsProvider } from '../src/ats/types.js';

/**
 * The second open dataset (kalil0321/ats-scrapers).
 *
 * Its value is only as real as the parse: a row that turns into the wrong token,
 * or into a board that cannot be addressed, is a verify request spent for
 * nothing — or worse, a bad row stored.
 */

// ------------------------------------------------------------------ the CSV

test('parses the standard name,slug,url,domain header', () => {
  const rows = parseCsv(
    'name,slug,url,domain\nVercel,vercel,https://boards.greenhouse.io/vercel,vercel.com\n',
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    name: 'Vercel',
    slug: 'vercel',
    url: 'https://boards.greenhouse.io/vercel',
    domain: 'vercel.com',
  });
});

test('a quoted company name keeps its comma', () => {
  const rows = parseCsv('name,slug,url\n"Acme, Inc.",acme,https://boards.greenhouse.io/acme\n');
  assert.equal(rows[0]?.name, 'Acme, Inc.');
  assert.equal(rows[0]?.slug, 'acme');
});

test('the legacy two-column name,url form with no header still parses', () => {
  // The publisher documents some files still carrying this older shape.
  const rows = parseCsv('Globex,https://jobs.lever.co/globex\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, 'Globex');
  assert.equal(rows[0]?.url, 'https://jobs.lever.co/globex');
  assert.equal(rows[0]?.slug, undefined);
});

// ------------------------------------------------------------ row -> board

test('a token-only provider uses the slug directly', () => {
  // acme.greenhouse.io is a subdomain resolveApplyUrl does not recognise, so the
  // slug is what makes this row usable at all.
  const b = rowToBoard('greenhouse', { name: 'Acme', slug: 'acme', url: 'https://acme.greenhouse.io' });
  assert.equal(b?.provider, 'greenhouse');
  assert.equal(b?.token, 'acme');
  assert.equal(b?.company, 'Acme');
});

test('a canonical board URL is resolved to its token', () => {
  const b = rowToBoard('greenhouse', { name: 'Vercel', url: 'https://boards.greenhouse.io/vercel' });
  assert.equal(b?.provider, 'greenhouse');
  assert.equal(b?.token, 'vercel');

  const l = rowToBoard('lever', { name: 'Globex', url: 'https://jobs.lever.co/globex' });
  assert.equal(l?.provider, 'lever');
  assert.equal(l?.token, 'globex');
});

test('a Workday URL yields the tenant, shard host and site', () => {
  // resolveApplyUrl reports Workday as unsupported on purpose, so this row is
  // only usable because datasets.ts parses the address itself.
  const b = rowToBoard('workday', {
    name: 'Fidelity',
    slug: 'fmr',
    url: 'https://fmr.wd1.myworkdayjobs.com/en-US/FidelityCareers',
  });
  assert.equal(b?.provider, 'workday');
  assert.equal(b?.token, 'fmr');
  assert.equal(b?.extra?.host, 'fmr.wd1.myworkdayjobs.com');
  assert.equal(b?.extra?.site, 'FidelityCareers');
  assert.equal(b?.extra?.locale, 'en-US');
});

test('a Workday URL with no locale still resolves the site', () => {
  const b = rowToBoard('workday', { slug: 'acme', url: 'https://acme.wd5.myworkdayjobs.com/External' });
  assert.equal(b?.extra?.site, 'External');
  assert.equal(b?.extra?.locale, 'en-US');
});

test('a Workday row with no parseable URL is dropped, not half-stored', () => {
  // A tenant with no site can never be fetched — storing it would fail every
  // crawl forever, which is exactly what "needs extra" is for.
  assert.equal(rowToBoard('workday', { name: 'Acme', slug: 'acme' }), null);
});

test('Eightfold takes its domain from the dataset column, not the careers URL', () => {
  const b = rowToBoard('eightfold', {
    name: 'Albemarle',
    slug: 'albemarle',
    url: 'https://albemarle.eightfold.ai/careers',
    domain: 'albemarle.com',
  });
  assert.equal(b?.provider, 'eightfold');
  assert.equal(b?.token, 'albemarle');
  assert.equal(b?.extra?.domain, 'albemarle.com');
});

test('an Eightfold row with no domain is dropped — it cannot be addressed', () => {
  // Eightfold refuses the API without the employer domain, and the dataset
  // leaves it blank for many rows.
  assert.equal(
    rowToBoard('eightfold', { name: 'Amdocs', slug: 'amdocs', url: 'https://amdocs.eightfold.ai/careers' }),
    null,
  );
});

test('a junk slug is rejected rather than stored as a token', () => {
  assert.equal(rowToBoard('greenhouse', { slug: 'has a space' }), null);
  assert.equal(rowToBoard('greenhouse', { slug: '-leadingdash' }), null);
  assert.equal(rowToBoard('greenhouse', {}), null);
});

// -------------------------------------------------------------- the mapping

test('every dataset file maps to a provider the verifier can actually check', () => {
  // Mapping a file to a provider with no verify endpoint would harvest
  // candidates, verify none, store nothing and report success — the silent
  // failure verify.ts warns about.
  const verifiable = new Set<AtsProvider>([
    'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'personio',
    'recruitee', 'teamtailor', 'bamboohr', 'rippling', 'breezy', 'icims',
    'workday', 'oracle', 'eightfold',
  ]);
  for (const { file, provider } of DATASET_FILES) {
    assert.ok(verifiable.has(provider), `${file} maps to ${provider}, which has no verify endpoint`);
  }
});

test('UKG is deliberately not mapped — its board id is not in the dataset', () => {
  assert.ok(!DATASET_FILES.some((f) => f.provider === 'ukg'));
});
