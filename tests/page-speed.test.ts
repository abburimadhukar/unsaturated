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

import { queryNewestFromDb, queryRowsFromDb } from '../src/corpus/db-query.js';

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

test('the feed route takes the fast road for the unfiltered AND the family-only newest views, and falls back', () => {
  const src = read('../app/api/feed/route.ts');
  // The fast road now also covers a bare family tab (isFamilyOnlyQuery).
  assert.match(src, /const familyFast = isFamilyOnlyQuery\(query\);/);
  assert.match(src, /const fast = query\.sort === 'newest' && \(isUnfilteredQuery\(query\) \|\| familyFast\);/);
  // feed_newest is asked for the family on a family tab, and unfiltered otherwise.
  assert.match(src, /queryNewestFromDb\(offset, limit, \{\}, familyFast \? \(query\.family \?\? null\) : null\)/);
  // The total comes from the counts, and a missing piece falls back to feed_page.
  assert.match(src, /const fastTotal = realFacets\?\.adjacent\?\.core;/);
  assert.match(src, /newest && typeof fastTotal === 'number'[\s\S]{0,160}: await queryFeedFromDb\(query, offset, limit\)/);
  // Guarded against a null total, which the last-resort rows-only path sets.
  assert.match(
    src,
    /hasMore: fromDb\.hasMore \?\? \(fromDb\.total !== null && offset \+ fromDb\.jobs\.length < fromDb\.total\)/,
  );
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

test('the p_family overload of feed_newest adds only the family filter, over the same base', () => {
  const sql = read('../src/db/migrations/2026-10-01-feed-family-fast.sql').replace(/--.*$/gm, '');
  // Same base filters as the 3-arg version, so a family tab and the default view
  // return the same rows but for the family narrowing.
  for (const cond of [
    /p_family {2}text/,
    /j\.closed_at is null/,
    /\(j\.posted_at >= p_cutoff or \(j\.posted_at is null and j\.first_seen_at >= p_cutoff\)\)/,
    /not coalesce\(j\.adjacent, false\)/,
    /p_family is null or j\.family = p_family/,
    /order by j\.posted_at desc nulls last, j\.key asc/,
  ]) assert.match(sql, cond);
  // Additive: the column is added if-not-exists and feed_page is still untouched.
  assert.match(sql, /add column if not exists by_family jsonb/);
  assert.doesNotMatch(sql, /function public\.feed_page/);
});

test('feed_rows is feed_page without the count, same filters', () => {
  const sql = read('../src/db/migrations/2026-10-01-feed-rows.sql').replace(/--.*$/gm, '');
  // Same filter and paging as feed_page, so it returns the same rows.
  for (const cond of [
    /function public\.feed_rows/,
    /j\.closed_at is null/,
    /p_family {5}is null or j\.family {6}= p_family/,
    /p_country is null/,
    /j\.title ilike '%' \|\| p_q \|\| '%'/,
    /order by\s+case when p_sort = 'salary'/,
    /offset p_offset/,
    /limit {2}p_limit/,
  ]) assert.match(sql, cond);
  // The whole point: no count, so it cannot time out on one.
  assert.doesNotMatch(sql, /'total', \(select count/);
  assert.doesNotMatch(sql, /'undated'/);
  // feed_page itself is not touched.
  assert.doesNotMatch(sql, /create or replace function public\.feed_page/i);
});

test('queryRowsFromDb asks feed_rows with the filters and no count', async () => {
  let asked: Record<string, unknown> = {};
  const client = {
    rpc: async (name: string, p: Record<string, unknown>) => {
      asked = { name, ...p };
      return { data: { rows: [row('a'), row('b')] }, error: null };
    },
  };
  const got = await queryRowsFromDb({ family: 'cloud', country: 'US' }, 0, 50, { client, wait: noWait });
  assert.equal(asked.name, 'feed_rows');
  assert.equal(asked.p_family, 'cloud');
  assert.equal(asked.p_country, 'US');
  assert.deepEqual(got?.map((j) => j.key), ['a', 'b']);
  // A refusal is retried once, then null — the same rule as feed_page.
  const refused = { rpc: async () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } }) };
  assert.equal(await queryRowsFromDb({}, 0, 50, { client: refused, wait: noWait }), null);
});

test('the route falls back to rows-only when feed_page times out on a filtered view', () => {
  const src = read('../app/api/feed/route.ts');
  // Only after feed_page has failed (sequential), never alongside it.
  assert.match(src, /if \(!fromDb && !query\.adjacent && typeof fastTotal === 'number'\)/);
  assert.match(src, /await queryRowsFromDb\(query, offset, limit\)/);
  // The total for that fallback comes from the facets, not an invented number.
  assert.match(src, /total: fastTotal/);
  // adjacent=include|only is excluded, because adjacent.core is not their total.
  assert.match(src, /!query\.adjacent/);
});

/**
 * THE 503 THAT WAS LEFT ON THE TABLE.
 *
 * The fallback above is gated on `typeof fastTotal === 'number'` — it needs the
 * COUNTS to have survived, because that is where it takes the total from. But
 * the failure this site actually has is both halves dying together: feed_page
 * and feed_facets are fired in the same Promise.all and compete for the same
 * 3-second budget. When both are refused, `fastTotal` is undefined, that gate
 * never opens, and the visitor gets "job data is temporarily unavailable" —
 * even though feed_rows, which counts nothing, would have answered.
 *
 * So there is a second fallback with NO gate on the facets. The rows are what a
 * visitor came for; the sidebar numbers are not.
 */
test('rows are served even when NOTHING could count them', () => {
  const src = read('../app/api/feed/route.ts');
  // Ungated: no facets, no fastTotal, no adjacent check — only "we have no page".
  assert.match(src, /if \(!fromDb\) \{\s*\n\s*const rows = await queryRowsFromDb\(query, offset, limit \+ 1\);/);
  // The total is unknown and is SAID to be unknown, never invented as 0.
  assert.match(src, /total: null,/);
  assert.doesNotMatch(src, /total: 0,/);
  // hasMore stays exact without a count, by fetching one row past the page.
  assert.match(src, /hasMore: rows\.length > limit,/);
  assert.match(src, /jobs: rows\.slice\(0, limit\),/);
  // An unknown total is cached as briefly as missing facets are.
  assert.match(src, /const degraded = facetsMissing \|\| fromDb\.total === null;/);
  assert.match(src, /cache-control', degraded \? DEGRADED_CACHE_HEADER : CACHE_HEADER/);
  // ...but it does NOT claim the facets were unavailable, because they may not
  // have been. The two conditions stay separate.
  assert.match(src, /const facetsMissing = realFacets === null;/);
});

test('the page shows an unknown total as unknown, not as zero', () => {
  const src = read('../app/page.tsx');
  // The headline figure.
  assert.match(src, /\{data\?\.matched \?\? '—'\}/);
  assert.doesNotMatch(src, /\{data\?\.matched \?\? 0\}/);
  // The type admits it can be absent, so a future caller cannot forget.
  assert.match(src, /matched: number \| null;/);
  // "N left" needs a total; the button still works without one.
  assert.match(src, /data\.matched != null\s*\n?\s*\? `Load more · \$\{data\.matched - jobs\.length\} left`/);
  // "showing N" is guarded rather than comparing against null.
  assert.match(src, /data\?\.matched != null && jobs\.length < data\.matched/);
});

test('the family tab passes the family through to feed_newest', async () => {
  let asked: Record<string, unknown> = {};
  const client = {
    rpc: async (name: string, p: Record<string, unknown>) => {
      asked = { name, ...p };
      return { data: { rows: [row('a')] }, error: null };
    },
  };
  await queryNewestFromDb(0, 50, { client, wait: noWait }, 'cloud');
  assert.equal(asked.name, 'feed_newest');
  assert.equal(asked.p_family, 'cloud');
  // The default view still sends null, not a family.
  await queryNewestFromDb(0, 50, { client, wait: noWait });
  assert.equal(asked.p_family, null);
});

/**
 * THE WARMER MUST SPELL URLS THE WAY THE BROWSER SPELLS THEM.
 *
 * scripts/warm-cache.mjs warmed `/api/feed` and `/api/feed?family=cloud&country=US`
 * for weeks. The browser asks for neither. The feed page serialises its WHOLE
 * filter state, defaults included (app/page.tsx `paramsFor`), so a visitor who
 * has touched nothing still sends country, cloudOnly, hideGhosts, sort and
 * limit. Cloudflare keys on the exact query string, so every warmed entry was
 * one no visitor would ever read — measured 2 Oct 2026, the real landing URL
 * was a MISS while the warmed one beside it was a HIT.
 *
 * This rebuilds the expected strings FROM FILTER_DEFAULTS rather than hardcoding
 * them, so if a default changes — or a new one is added — this fails instead of
 * silently orphaning the warm list again.
 */
/** The non-family part of a default feed URL, as both the browser and the warmer spell it. */
const TAIL_EXPECTED = 'cloudOnly=1&hideGhosts=1&sort=newest&limit=50';

test('the warm list matches the URLs the feed page actually requests', async () => {
  const { FILTER_DEFAULTS } = await import('../src/ui/filter-state.js');
  const warm = read('../scripts/warm-cache.mjs');

  // Exactly `paramsFor` in app/page.tsx, for a view nobody has touched.
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(FILTER_DEFAULTS)) {
    if (k === 'includeUnknown' || k === 'hideSeen' || k === 'minFit' || k === 'onlyApplied') continue;
    if (k === 'sort' && v === 'fit') continue;
    if (v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const landing = `${p.toString()}&limit=50`;

  // The defaults that survive must be the ones the warmer hardcodes as TAIL,
  // plus the country. If a default is added or flipped, this is where it shows.
  assert.equal(
    landing,
    `country=US&${TAIL_EXPECTED}`,
    'FILTER_DEFAULTS changed — update TAIL in scripts/warm-cache.mjs to match',
  );
  // No regex metacharacters in a query string of this shape, so it embeds as-is.
  assert.ok(warm.includes(`const TAIL = '${TAIL_EXPECTED}';`), 'warm-cache.mjs TAIL must match');

  // A family tab, built the same way: `family` is serialised BEFORE `country`,
  // because that is their order in FILTER_DEFAULTS and Cloudflare keys on the
  // exact string. Getting this backwards would orphan the four tabs again.
  const withFamily = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...FILTER_DEFAULTS, family: 'cloud' })) {
    if (k === 'includeUnknown' || k === 'hideSeen' || k === 'minFit' || k === 'onlyApplied') continue;
    if (v === '' || v === false) continue;
    withFamily.set(k, v === true ? '1' : String(v));
  }
  assert.equal(
    `${withFamily.toString()}&limit=50`,
    `family=cloud&country=US&${TAIL_EXPECTED}`,
    'family must be serialised before country',
  );

  // The warmer must not still be warming the bare URLs nobody asks for.
  assert.doesNotMatch(warm, /'\/api\/feed',/, 'bare /api/feed is not a URL the browser sends');
  assert.doesNotMatch(warm, /\/api\/feed\?family=\$\{f\}&sort=newest/);
});

/**
 * The snapshot shapes have to be reachable by a real request.
 *
 * isUnfilteredQuery / isFamilyOnlyQuery / isCountryScopedQuery all require
 * `hideGhosts !== true`, but FILTER_DEFAULTS sets `hideGhosts: true` and
 * `paramsFor` sends it on every request — so no visitor can ever reach the
 * stored counts, and every page view runs the live feed_facets instead. That is
 * why production shows 0-7 facet_snapshot reads an hour against 30-95
 * feed_facets calls.
 *
 * FIXED by isDefaultShapeQuery, which matches that state exactly. This test is
 * the regression guard: it derives the query from FILTER_DEFAULTS rather than
 * hardcoding it, so changing a default that makes the landing view unreachable
 * again fails here.
 */
test('THE DEFAULT UI STATE REACHES THE SNAPSHOT', async () => {
  const { FILTER_DEFAULTS } = await import('../src/ui/filter-state.js');
  const {
    isUnfilteredQuery, isFamilyOnlyQuery, isCountryScopedQuery, isDefaultShapeQuery,
  } = await import('../src/corpus/db-query.js');

  // The query app/api/feed/route.ts builds from an untouched UI.
  const asRouteSeesIt = {
    cloudOnly: true,
    hideGhosts: FILTER_DEFAULTS.hideGhosts === true,
    country: FILTER_DEFAULTS.country || undefined,
    sort: 'newest' as const,
  };

  // The landing view, each family tab, and the country-cleared versions.
  assert.equal(isDefaultShapeQuery(asRouteSeesIt), true, 'the landing view must be stored');
  for (const family of ['cloud', 'software', 'data', 'hris']) {
    assert.equal(isDefaultShapeQuery({ ...asRouteSeesIt, family }), true, `${family} tab`);
    assert.equal(
      isDefaultShapeQuery({ ...asRouteSeesIt, family, country: undefined }), true,
      `${family} tab, country cleared`,
    );
  }

  // The older three still require ghosts shown, and still do not match — they
  // serve the g0 numbers and must never answer a g1 request.
  assert.equal(isUnfilteredQuery(asRouteSeesIt), false);
  assert.equal(isFamilyOnlyQuery({ ...asRouteSeesIt, family: 'cloud' }), false);
  assert.equal(isCountryScopedQuery(asRouteSeesIt), false);
});

/**
 * The headline total and the sidebar counts must come from the same place.
 *
 * The default views match isDefaultShapeQuery, so their counts come from the
 * per-crawl snapshot. If the ROWS came from feed_page, its own live count would
 * become the headline "N roles" while the sidebar showed stored numbers — two
 * figures from two different moments, side by side, disagreeing whenever the
 * snapshot was behind. feed_rows takes the full filter set and does not count,
 * so the total can come from the same stored answer the sidebar does.
 */
test('the default views take their total from the same counts as the sidebar', () => {
  const src = read('../app/api/feed/route.ts');
  assert.match(src, /const shapeFast = isDefaultShapeQuery\(query\);/);
  // Rows via feed_rows, one past the page so hasMore needs no count.
  assert.match(src, /shapeFast \? queryRowsFromDb\(query, offset, limit \+ 1\)/);
  // feed_page is skipped for these views, not run alongside.
  assert.match(src, /fast \|\| shapeFast \? Promise\.resolve\(null\) : queryFeedFromDb\(query, offset, limit\)/);
  // The total is the counts' own figure, never an invented one.
  assert.match(src, /total: fastTotal,/);
  assert.match(src, /hasMore: shapeRows\.length > limit,/);
  // And a missing piece falls back to feed_page rather than guessing.
  assert.match(src, /: await queryFeedFromDb\(query, offset, limit\);/);
});
