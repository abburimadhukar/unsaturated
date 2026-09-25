import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFacets } from '../src/corpus/page-facets.js';
import { subjectOf } from '../src/state/auth.js';

/**
 * The speed fixes of 25 Sep 2026: one count query per page instead of
 * seventeen, the Worker placed beside the database, the sign-in checks run
 * together, and no pause before the first feed request.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const noWait = async () => {};
const ok = { counts: { cloud: 3 }, countries: { US: 2 }, countryUnknown: 1 };

test('page counts come back as given', async () => {
  const got = await pageFacets('quiet_facets', {}, { rpc: async () => ({ data: ok, error: null }), wait: noWait });
  assert.deepEqual(got, ok);
});

test('a refused count is retried once, then given up on as null — never zeros', async () => {
  let calls = 0;
  const refused = async () => { calls++; return { data: null, error: { message: 'canceling statement due to statement timeout' } }; };
  assert.equal(await pageFacets('quiet_facets', {}, { rpc: refused, wait: noWait }), null);
  assert.equal(calls, 2);

  calls = 0;
  const thenOk = async () => (++calls === 1
    ? { data: null, error: { message: 'canceling statement due to statement timeout' } }
    : { data: ok, error: null });
  assert.deepEqual(await pageFacets('quiet_facets', {}, { rpc: thenOk, wait: noWait }), ok);
});

test('a real error is not retried, and a thrown one does not escape', async () => {
  let calls = 0;
  const missing = async () => { calls++; return { data: null, error: { message: 'Could not find the function public.quiet_facets' } }; };
  assert.equal(await pageFacets('quiet_facets', {}, { rpc: missing, wait: noWait }), null);
  assert.equal(calls, 1);
  const boom = async () => { throw new Error('network down'); };
  assert.equal(await pageFacets('institution_facets', {}, { rpc: boom, wait: noWait }), null);
});

test('a malformed answer is null, not a page of zeros', async () => {
  assert.equal(await pageFacets('quiet_facets', {}, { rpc: async () => ({ data: { nope: 1 }, error: null }), wait: noWait }), null);
});

test('neither page counts option by option any more', () => {
  for (const p of ['../app/api/quiet/route.ts', '../app/api/institutions/route.ts']) {
    const src = read(p);
    assert.match(src, /pageFacets\('(quiet|institution)_facets'/, p);
    assert.doesNotMatch(src, /\.range\(0, 0\)/, `${p} still counts with one request per option`);
  }
});

test('the quiet counts are restricted to the families on the page', () => {
  // Without it the scan also tallied ~48,500 unsorted rows the page never shows.
  assert.match(read('../src/db/migrations/2026-09-25-page-facets.sql'), /family = any \(p_families\)/);
  assert.match(read('../app/api/quiet/route.ts'), /p_families: FAMILIES/);
});

// --- sign-in ----------------------------------------------------------------

const jwt = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

test('the claimed user id is read from a token without padding', () => {
  assert.equal(subjectOf(jwt({ sub: 'b6f1c2d0-1111-4222-8333-444455556666' })), 'b6f1c2d0-1111-4222-8333-444455556666');
  assert.equal(subjectOf(jwt({ sub: 'a' })), 'a');
});

test('a token with no usable claim yields null rather than throwing', () => {
  for (const t of ['', 'nodots', 'a.!!!.c', jwt({}), jwt({ sub: 42 }), jwt({ sub: '' })]) {
    assert.equal(subjectOf(t), null, t);
  }
});

test('the seat check runs alongside the token check, and both must still pass', () => {
  const src = read('../src/state/auth.ts');
  assert.match(src, /Promise\.all\(\[\s*auth\(\)\.auth\.getUser\(token\),\s*claimed \? hasSeat\(token, claimed\)/);
  // The claim is only trusted when the verified id agrees with it.
  assert.match(src, /if \(claimed === user\.id\) return seated \? \{ user \} : null;/);
  // Disagreement falls back to checking the verified id, never the claim.
  assert.match(src, /if \(await hasSeat\(token, user\.id\)\) return \{ user \};/);
});

// --- placement and first load -----------------------------------------------

test('the Worker is placed beside the database', () => {
  const cfg = read('../wrangler.jsonc');
  // us-east-1 is where the Supabase project runs (checked 25 Sep 2026). If the
  // database ever moves, this has to move with it.
  assert.match(cfg, /"placement":\s*\{\s*"region":\s*"aws:us-east-1"\s*\}/);
});

test('the first feed request is not debounced; later ones are', () => {
  const page = read('../app/page.tsx');
  assert.match(page, /const wait = firstLoad\.current \? 0 : 250;/);
});

// --- the default feed view ---------------------------------------------------

import { queryNewestFromDb } from '../src/corpus/db-query.js';

const row = (key: string) => ({
  key, title: 't', company: 'c', provider: 'greenhouse', location: null, country: null,
  remote_type: null, seniority: null, employment_type: null, salary_min: null, salary_max: null,
  salary_currency: null, posted_at: '2026-09-25T00:00:00Z', first_seen_at: '2026-09-25T00:00:00Z',
  apply_url: null, family: 'cloud',
});

test('the default view asks for one row more than it shows, so hasMore is exact', async () => {
  let asked: Record<string, unknown> = {};
  const client = {
    rpc: async (name: string, p: Record<string, unknown>) => {
      asked = { name, ...p };
      return { data: { rows: [row('a'), row('b'), row('c')] }, error: null };
    },
  };
  const got = await queryNewestFromDb(100, 2, { client, wait: noWait });
  assert.equal(asked.name, 'feed_newest');
  assert.equal(asked.p_offset, 100);
  assert.equal(asked.p_limit, 3);
  assert.deepEqual(got?.jobs.map((j) => j.key), ['a', 'b']);
  assert.equal(got?.hasMore, true);

  const last = await queryNewestFromDb(0, 5, {
    client: { rpc: async () => ({ data: { rows: [row('a')] }, error: null }) }, wait: noWait,
  });
  assert.equal(last?.hasMore, false);
});

test('the default view retries a refusal once, and otherwise hands back null', async () => {
  let calls = 0;
  const refused = { rpc: async () => { calls++; return { data: null, error: { message: 'canceling statement due to statement timeout' } }; } };
  assert.equal(await queryNewestFromDb(0, 50, { client: refused, wait: noWait }), null);
  assert.equal(calls, 2);
  const missing = { rpc: async () => ({ data: null, error: { message: 'Could not find the function public.feed_newest' } }) };
  assert.equal(await queryNewestFromDb(0, 50, { client: missing, wait: noWait }), null);
});

test('the feed route uses the fast road only for the unfiltered newest view, and falls back', () => {
  const src = read('../app/api/feed/route.ts');
  assert.match(src, /const fast = query\.sort === 'newest' && isUnfilteredQuery\(query\);/);
  // The total comes from the counts, and a missing piece falls back to feed_page.
  assert.match(src, /const fastTotal = realFacets\?\.adjacent\?\.core;/);
  assert.match(src, /newest && typeof fastTotal === 'number'[\s\S]{0,160}: await queryFeedFromDb\(query, offset, limit\)/);
  assert.match(src, /hasMore: fromDb\.hasMore \?\? offset \+ fromDb\.jobs\.length < fromDb\.total/);
});

test('feed_newest filters exactly as feed_page does with every parameter at its default', () => {
  const sql = read('../src/db/migrations/2026-09-25-feed-newest.sql').replace(/--.*$/gm, '');
  for (const cond of [
    /j\.closed_at is null/,
    /j\.family is not null/,
    /j\.posted_at >= p_cutoff or \(j\.posted_at is null and j\.first_seen_at >= p_cutoff\)/,
    /coalesce\(j\.family, ''\) <> 'unsorted'/,
    /not coalesce\(j\.adjacent, false\)/,
    /order by j\.posted_at desc nulls last, j\.key asc/,
    /- 'specialization_reason' - 'classification_version'/,
  ]) assert.match(sql, cond);
  // feed_page itself is not touched by this change.
  assert.doesNotMatch(sql, /function public\.feed_page/);
});
