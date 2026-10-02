import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isUnfilteredQuery,
  isFamilyOnlyQuery,
  isCountryScopedQuery,
  isDefaultShapeQuery,
  countryFacetKey,
  shapeFacetKey,
  SNAPSHOT_FAMILIES,
  SNAPSHOT_COUNTRIES,
} from '../src/corpus/db-query.js';

/**
 * The filter counts, computed once per crawl instead of once per page view.
 *
 * feed_facets was 16% of all database time — 26,377 calls, 273ms mean, 2,992ms
 * worst — which is TWICE what feed_page costs. Counting the filter options was
 * more expensive than fetching the jobs being filtered, and it was recomputed
 * on every page view even though the corpus only changes when a crawl finishes.
 *
 * It was also a correctness bug, not just a slow one. facetsFromDb returns null
 * on a refusal and the feed route substitutes EMPTY facets for a null, so a
 * timed-out count rendered the site with every filter at zero and the total
 * reading 0 — with the jobs listed right beside them. Caught live on 24 Sep:
 *
 *   {"total":0,"facets":{"family":{},"country":{}}}
 *   {"total":669191,"facets":{"family":{"cloud":12437,"software":17258}}}
 *
 * Same endpoint, seconds apart. Not an error page: a site that looks empty.
 */

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/.*$/gm, ' ');
const querySource = readFileSync(new URL('../src/corpus/db-query.ts', import.meta.url), 'utf8');
const query = strip(querySource);
const snapshot = strip(readFileSync(new URL('../src/corpus/facet-snapshot.ts', import.meta.url), 'utf8'));
const cli = strip(readFileSync(new URL('../src/cli/crawl-db.ts', import.meta.url), 'utf8'));

test('the default view is recognised as unfiltered', () => {
  assert.equal(isUnfilteredQuery({}), true);
  // The two that default to TRUE and are only false when asked.
  assert.equal(isUnfilteredQuery({ cloudOnly: true, includeUnknown: true }), true);
  assert.equal(isUnfilteredQuery({ cloudOnly: false }), false);
  assert.equal(isUnfilteredQuery({ includeUnknown: false }), false);
});

test('any filter at all makes it not the default view', () => {
  // Wrong counts are worse than slow ones, so every one of these must opt out.
  const filtered = [
    { family: 'cloud' }, { country: 'US' }, { remote: 'remote' }, { seniority: 'senior' },
    { employmentType: 'permanent' }, { provider: 'greenhouse' }, { q: 'engineer' },
    { stack: 'python' }, { specialization: 'backend' }, { adjacent: 'only' },
    { hasSalary: true }, { ai: true }, { hideGhosts: true },
    { minSalary: 100000 }, { postedWithinDays: 7 },
  ];
  for (const f of filtered) {
    assert.equal(isUnfilteredQuery(f), false, `${JSON.stringify(f)} was treated as unfiltered`);
  }
});

test('every filter feed_facets takes is one the default check knows about', () => {
  // The failure this prevents: a filter added to the RPC call and not to
  // isUnfilteredQuery would be served the UNFILTERED counts — a filtered page
  // showing whole-corpus numbers, silently.
  const call = /rpc\('feed_facets',\s*\{([\s\S]*?)\n\s*\}\);/.exec(query);
  assert.ok(call, 'could not find the feed_facets call');
  const params = [...call[1]!.matchAll(/p_(\w+):/g)].map((m) => m[1]!);
  // Not filters: the window, and the page/sort arguments feed_page adds.
  const notAFilter = new Set(['cutoff']);
  const fn = /export function isUnfilteredQuery[\s\S]*?\n\}/.exec(query)?.[0] ?? '';
  const known: Record<string, string> = {
    in_scope: 'cloudOnly', keep_unknown: 'includeUnknown', employment: 'employmentType',
    has_salary: 'hasSalary', min_salary: 'minSalary', within_days: 'postedWithinDays',
    hide_ghosts: 'hideGhosts',
  };
  for (const p of params) {
    if (notAFilter.has(p)) continue;
    const field = known[p] ?? p;
    assert.ok(
      fn.includes(field),
      `feed_facets takes p_${p} but isUnfilteredQuery never looks at "${field}"`,
    );
  }
});

test('the snapshot is only read for the default view, and never by its own writer', () => {
  assert.match(query, /opts\.snapshot !== false/);
  assert.match(query, /isUnfilteredQuery\(f\)/);
  // The writer must compute fresh counts, or it would read back the copy it is
  // about to replace and store it again forever.
  assert.match(snapshot, /facetsFromDb\(\{\}, \{ snapshot: false, client: dbWrite\(\) \}\)/);
});

test('a stale snapshot is ignored rather than served', () => {
  assert.match(query, /SNAPSHOT_MAX_AGE_MS/);
  assert.match(query, /age < SNAPSHOT_MAX_AGE_MS/);
});

test('refreshing the snapshot can never fail a crawl', () => {
  // Same rule as the purge and the tally: a crawl that stored its jobs must not
  // go red because a cache did not refresh.
  assert.doesNotMatch(snapshot, /throw new Error/);
  assert.match(snapshot, /catch \(err\)/);
  assert.match(snapshot, /console\.warn\(/);
});

/**
 * THE COUNTS ARE WRITTEN AFTER THE WHOLE CRAWL, NOT DURING IT.
 *
 * They used to be written by shard 0 the moment it finished, while shards 1-3
 * kept crawling and writing for minutes afterwards — asking for the most
 * expensive read in the database, cold, while three jobs hammered it. A cold
 * feed_facets is ~13 s against the write client's 8-second budget.
 *
 * Measured 2 Oct 2026: attempt 1 failed on EVERY recent crawl, the 13:10 run
 * failed all three, and the counts had gone seven and a half hours unwritten.
 * Invisible, because nothing read them until isDefaultShapeQuery landed.
 */
test('the crawl no longer writes the counts itself', () => {
  // `cli` has its comments stripped, so this is the code, not the explanation.
  assert.doesNotMatch(cli, /refreshFacetSnapshot/);
  assert.doesNotMatch(cli, /shard\.index === 0\) await refreshFacetSnapshot/);
  // The raw file, to check it says where they went rather than leaving the
  // next reader to wonder why the call vanished.
  const raw = readFileSync(new URL('../src/cli/crawl-db.ts', import.meta.url), 'utf8');
  assert.match(raw, /snapshot:facets/);
});

test('the counts job runs after every shard, and warming runs after it', () => {
  const wf = readFileSync(new URL('../.github/workflows/crawl.yml', import.meta.url), 'utf8');
  // Its own job, depending on the whole crawl matrix.
  assert.match(wf, /^ {2}counts:\s*\n\s*needs: crawl\s*\n\s*if: always\(\)/m);
  assert.match(wf, /run: npm run snapshot:facets/);
  // It needs the write key, or dbWrite falls back to the publishable one and
  // RLS refuses the upsert.
  assert.match(wf, /SUPABASE_SECRET_KEY: \$\{\{ secrets\.SUPABASE_SECRET_KEY \}\}/);
  // Warming must come AFTER the counts, or it caches the slow live answer.
  assert.match(wf, /needs: \[crawl, counts\]/);
});

/**
 * crawl.yml fires SIX TIMES AN HOUR — GitHub drops most scheduled runs, so the
 * cron over-declares and `crawl:db` exits in seconds on five of the six. The
 * crawl job therefore succeeds six times an hour, and a `needs: crawl` job
 * with no guard of its own would run the whole 20-query pass every time: six
 * an hour against the ~5 a day it needs, which is MORE load than the bug this
 * was written to fix.
 */
test('the counts job skips when no crawl has happened since the last count', () => {
  const entry = readFileSync(new URL('../src/cli/facet-counts.ts', import.meta.url), 'utf8');
  assert.match(entry, /async function crawlSinceLastCount\(\)/);
  assert.match(entry, /if \(!\(await crawlSinceLastCount\(\)\)\) return;/);
  // The exact comparison, not a timer: shards finish at different moments and
  // max(finished_at) is the whole crawl's end.
  assert.match(entry, /crawl_runs/);
  assert.match(entry, /facet_snapshot/);
  assert.match(entry, /if \(crawled <= counted\)/);
  // Fails OPEN — counting when we need not is waste, skipping when we must is
  // a stale site.
  assert.match(entry, /\/\/ Cannot tell — count rather than skip\./);
  // And a manual override, like the crawl's own --force.
  assert.match(entry, /--force/);
});

test('the counts command exists and reports failure loudly', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts['snapshot:facets'], 'tsx src/cli/facet-counts.ts');

  const entry = readFileSync(new URL('../src/cli/facet-counts.ts', import.meta.url), 'utf8');
  // Silence for seven hours is the bug being fixed, so a failure must be red.
  assert.match(entry, /process\.exitCode = 1/);
  assert.match(entry, /filter counts NOT stored/);
  // And it refuses to report success when it has no key to write with.
  assert.match(entry, /if \(!canWrite\(\)\)/);
});

test('the refresh uses the write client, not the publishable one', () => {
  // `anon` carries a 3-second statement timeout; the crawler's key gets 8. The
  // first version used db() and so asked for the most expensive read in the
  // database, at the busiest moment of the day, on the tightest budget of any
  // client. It failed on the first run it ever had.
  assert.match(snapshot, /client: dbWrite\(\)/);
  // The publishable client must not appear here at all. Written as a plain
  // string search rather than a regex: the first attempt anchored "db(" with
  // a word boundary, the backslash was lost writing the file, and the test
  // shipped a literal backspace byte the control-character guard then caught.
  assert.ok(!snapshot.includes('client: db()'), 'the refresh must not use the anon client');
});

test('it retries, and waits between attempts rather than hammering', () => {
  // What competes with this query is the crawl that just finished, so the
  // useful response is to let it drain — not to ask again immediately.
  assert.match(snapshot, /const TRIES = \[0, \d+_?\d*, \d+_?\d*\]/);
  assert.match(snapshot, /if \(pause\) await wait\(pause\)/);
});

// --- the per-family snapshot (1 Oct 2026) -----------------------------------

test('a bare family tab is recognised, and any extra filter opts out', () => {
  // The second shape the snapshot can answer: only the family narrowed, to one
  // of the real four, newest first.
  for (const fam of SNAPSHOT_FAMILIES) {
    assert.equal(isFamilyOnlyQuery({ family: fam }), true, `${fam} alone should qualify`);
  }
  // 'unsorted' is a review queue, never a landing page, so it is never pre-counted.
  assert.equal(isFamilyOnlyQuery({ family: 'unsorted' }), false);
  // No family at all is the UNFILTERED shape, not this one.
  assert.equal(isFamilyOnlyQuery({}), false);
  // Any further filter alongside the family falls back to the live count — a
  // stored per-family number cannot stand in for a filtered one.
  for (const extra of [
    { country: 'US' }, { remote: 'remote' }, { seniority: 'senior' }, { q: 'engineer' },
    { specialization: 'backend' }, { adjacent: 'only' }, { cloudOnly: false }, { includeUnknown: false },
  ]) {
    assert.equal(
      isFamilyOnlyQuery({ family: 'cloud', ...extra }),
      false,
      `cloud + ${JSON.stringify(extra)} must not use the per-family snapshot`,
    );
  }
});

test('the writer computes and stores a count for each family', () => {
  // One call per family, through the write client (the 8-second budget), and the
  // results stored under by_family so a family tab can read them.
  assert.match(snapshot, /for \(const fam of SNAPSHOT_FAMILIES\)/);
  assert.match(snapshot, /facetsFromDb\(\{ family: fam \}, \{ snapshot: false, client: dbWrite\(\) \}\)/);
  assert.match(snapshot, /by_family: byFamily/);
  // Best-effort and independent: a family that does not come back is left out,
  // never a thrown error that would fail the crawl.
  assert.doesNotMatch(snapshot, /throw/);
});

test('the reader serves a family tab from by_family', () => {
  assert.match(query, /isFamilyOnlyQuery\(f\)/);
  assert.match(query, /select\('facets,by_family,by_country,computed_at'\)/);
  assert.match(query, /row\.by_family\[f\.family\]/);
});

// --- the country-scoped snapshot (2 Oct 2026) -------------------------------

/**
 * The third shape, and the one that was actually returning 503s.
 *
 * A family plus the US ran feed_page (388ms) and feed_facets (2,199ms) at the
 * same time against anon's 3-second ceiling. Alone the counts just fit; with six
 * requests in flight the same call measured 11,413ms, both halves were killed,
 * and a feed with no rows is "job data is temporarily unavailable". The degraded
 * answer carries a short max-age, so the failure is never cached and every
 * visitor pays for it again.
 */

test('a country-scoped view is recognised, with or without a family', () => {
  assert.equal(isCountryScopedQuery({ country: 'US' }), true);
  for (const fam of SNAPSHOT_FAMILIES) {
    assert.equal(isCountryScopedQuery({ family: fam, country: 'US' }), true, `${fam}+US should qualify`);
  }
  // Only the pre-counted countries. GB came back in 1.2s and is left live.
  assert.equal(isCountryScopedQuery({ country: 'GB' }), false);
  assert.equal(isCountryScopedQuery({ family: 'cloud', country: 'GB' }), false);
  // 'unsorted' is a review queue and is never pre-counted, here either.
  assert.equal(isCountryScopedQuery({ family: 'unsorted', country: 'US' }), false);
  // No country at all is one of the other two shapes, not this one.
  assert.equal(isCountryScopedQuery({}), false);
  assert.equal(isCountryScopedQuery({ family: 'cloud' }), false);
});

test('any extra filter drops a country-scoped view back to the live count', () => {
  // A stored country number cannot stand in for a further-filtered one.
  for (const extra of [
    { remote: 'remote' }, { seniority: 'senior' }, { employmentType: 'permanent' },
    { provider: 'greenhouse' }, { q: 'engineer' }, { stack: 'python' },
    { specialization: 'backend' }, { adjacent: 'only' }, { hasSalary: true },
    { ai: true }, { hideGhosts: true }, { minSalary: 100000 }, { postedWithinDays: 7 },
    { cloudOnly: false }, { includeUnknown: false },
  ]) {
    assert.equal(
      isCountryScopedQuery({ family: 'cloud', country: 'US', ...extra }),
      false,
      `cloud+US + ${JSON.stringify(extra)} must not use the stored counts`,
    );
  }
});

test('every filter feed_facets takes is one the country check knows about', () => {
  // The same guard as the default view: a filter added to the RPC and not to
  // isCountryScopedQuery would be served counts that ignore it.
  const call = /rpc\('feed_facets',\s*\{([\s\S]*?)\n\s*\}\);/.exec(query);
  assert.ok(call, 'could not find the feed_facets call');
  const params = [...call[1]!.matchAll(/p_(\w+):/g)].map((m) => m[1]!);
  const notAFilter = new Set(['cutoff']);
  const fn = /export function isCountryScopedQuery[\s\S]*?\n\}/.exec(query)?.[0] ?? '';
  const known: Record<string, string> = {
    in_scope: 'cloudOnly', keep_unknown: 'includeUnknown', employment: 'employmentType',
    has_salary: 'hasSalary', min_salary: 'minSalary', within_days: 'postedWithinDays',
    hide_ghosts: 'hideGhosts',
  };
  for (const p of params) {
    if (notAFilter.has(p)) continue;
    const field = known[p] ?? p;
    assert.ok(
      fn.includes(field),
      `feed_facets takes p_${p} but isCountryScopedQuery never looks at "${field}"`,
    );
  }
});

test('the stored key cannot collide between a family and no family', () => {
  assert.equal(countryFacetKey('cloud', 'US'), 'cloud|US');
  assert.equal(countryFacetKey(null, 'US'), '*|US');
  assert.equal(countryFacetKey(undefined, 'US'), '*|US');
  assert.notEqual(countryFacetKey(null, 'US'), countryFacetKey('cloud', 'US'));
});

test('the writer stores a count for each country, and each family within it', () => {
  assert.match(snapshot, /for \(const country of SNAPSHOT_COUNTRIES\)/);
  assert.match(snapshot, /for \(const fam of \[null, \.\.\.SNAPSHOT_FAMILIES\]\)/);
  // Computed through the same function the live path calls, on the 8-second
  // budget — a snapshot that disagreed with the live answer is worse than none.
  assert.match(snapshot, /\{ snapshot: false, client: dbWrite\(\) \}/);
  assert.match(snapshot, /by_country: byCountry/);
});

test('a missing by_country column cannot take the other snapshots down with it', () => {
  // Migrations here are applied by hand, so the code can land before the column.
  // One unknown column failing the whole upsert would turn an optimisation into
  // an outage for the default view and every family tab.
  assert.match(snapshot, /column "\?by_country"\? \.\*does not exist/);
  assert.match(snapshot, /upsert\(\{ id: true, facets, by_family: byFamily, computed_at: computedAt \}/);
});

test('the reader serves a country-scoped view from by_country, or falls through', () => {
  assert.match(query, /isCountryScopedQuery\(f\)/);
  assert.match(query, /row\.by_country\[countryFacetKey\(f\.family, f\.country\)\]/);
});

test('the warmer warms exactly the combinations the crawl pre-counts', () => {
  // If these drift apart the warmer heats a view the origin still computes live.
  const warmer = strip(readFileSync(new URL('../scripts/warm-cache.mjs', import.meta.url), 'utf8'));
  for (const c of SNAPSHOT_COUNTRIES) {
    assert.ok(warmer.includes(`'${c}'`), `the warmer does not warm ${c}`);
  }
  // The warmer now builds feed URLs through a helper that spells them the way
  // the browser does — defaults and `limit` included — rather than by
  // interpolating a bare `country=`. See the warm-list test in
  // page-speed.test.ts, which rebuilds the expected strings from
  // FILTER_DEFAULTS. Here we only check the country still reaches that helper.
  assert.match(warmer, /country=\$\{country\}/);
  assert.match(warmer, /feed\(\{ country: 'US' \}\)/);
});

// ---------------------------------------------------------------------------
// The shapes the UI actually sends
// ---------------------------------------------------------------------------

/**
 * Every predicate above requires `hideGhosts !== true`, and FILTER_DEFAULTS
 * sets `hideGhosts: true` — so for as long as the snapshot has existed, no
 * visitor could reach it. isDefaultShapeQuery covers that state.
 *
 * The danger in fixing it is serving the WRONG number: a count taken with
 * ghosts included is not the same count as one taken with them hidden. These
 * tests exist mostly to prove the two sets can never answer for each other.
 */

test('a ghosts-hidden key can never collide with a ghosts-shown one', () => {
  // Two parts versus three.
  assert.equal(countryFacetKey('cloud', 'US'), 'cloud|US');
  assert.equal(shapeFacetKey('cloud', 'US', true), 'cloud|US|g1');
  assert.notEqual(shapeFacetKey('cloud', 'US', true), countryFacetKey('cloud', 'US'));
  // And the two ghost settings are distinct keys.
  assert.notEqual(shapeFacetKey('cloud', 'US', true), shapeFacetKey('cloud', 'US', false));
  // '*' marks "not narrowed" on either axis.
  assert.equal(shapeFacetKey(null, null, true), '*|*|g1');
  assert.equal(shapeFacetKey(null, 'US', true), '*|US|g1');
  assert.equal(shapeFacetKey('cloud', null, true), 'cloud|*|g1');
});

test('isDefaultShapeQuery matches only ghosts-hidden views, and only known ones', () => {
  const base = { hideGhosts: true as const };
  assert.equal(isDefaultShapeQuery(base), true);
  assert.equal(isDefaultShapeQuery({ ...base, country: 'US' }), true);
  assert.equal(isDefaultShapeQuery({ ...base, family: 'cloud', country: 'US' }), true);

  // Ghosts shown is the OTHER set's business.
  assert.equal(isDefaultShapeQuery({ hideGhosts: false }), false);
  assert.equal(isDefaultShapeQuery({}), false);

  // A country or family we do not pre-count falls through to the live path.
  assert.equal(isDefaultShapeQuery({ ...base, country: 'GB' }), false);
  assert.equal(isDefaultShapeQuery({ ...base, family: 'unsorted' }), false);

  // Any further narrowing falls through — a stored number cannot stand in.
  for (const extra of [
    { remote: 'fully_remote' }, { seniority: 'senior' }, { employmentType: 'full_time' },
    { provider: 'greenhouse' }, { q: 'engineer' }, { stack: 'python' },
    { specialization: 'devops_sre' }, { adjacent: 'include' },
    { hasSalary: true }, { ai: true }, { minSalary: 100000 }, { postedWithinDays: 7 },
    { cloudOnly: false }, { includeUnknown: false },
  ]) {
    assert.equal(
      isDefaultShapeQuery({ ...base, ...extra }), false,
      `${JSON.stringify(extra)} must fall through to the live count`,
    );
  }
});

test('every feed_facets parameter is accounted for by isDefaultShapeQuery', () => {
  // The same guard the other predicates carry: a filter added to feed_facets and
  // not added here would be served counts that ignore it.
  const params = [...query.matchAll(/p_(\w+):/g)].map((m) => m[1]);
  const known = new Set([
    'cutoff', 'in_scope', 'hide_ghosts', 'family', 'country', 'remote', 'seniority',
    'employment', 'provider', 'q', 'has_salary', 'min_salary', 'within_days', 'ai',
    'keep_unknown', 'stack', 'specialization', 'adjacent',
    'sort', 'offset', 'limit', 'rows',
  ]);
  for (const p of params) {
    assert.ok(known.has(p!), `feed_facets gained p_${p} — add it to isDefaultShapeQuery`);
  }
});

test('the writer stores the ghosts-hidden grid, computed and not derived', () => {
  // Both axes, including the country-cleared views.
  assert.match(snapshot, /for \(const country of \[null, \.\.\.SNAPSHOT_COUNTRIES\]\)/);
  assert.match(snapshot, /for \(const fam of \[null, \.\.\.SNAPSHOT_FAMILIES\]\)/);
  // hideGhosts: true must reach facetsFromDb, or the stored number is the wrong
  // one under a key that claims otherwise.
  assert.match(snapshot, /hideGhosts: true/);
  assert.match(snapshot, /byCountry\[shapeFacetKey\(fam, country, true\)\] = shaped/);
  // Through the write client, for the 8-second budget rather than anon's 3.
  assert.match(snapshot, /\{ snapshot: false, client: dbWrite\(\) \}/);
});

test('the reader serves a default-shape view from its own key', () => {
  assert.match(query, /isDefaultShapeQuery\(f\)/);
  assert.match(query, /row\.by_country\[shapeFacetKey\(f\.family, f\.country, true\)\]/);
  // And it is one of the shapes that opens the snapshot read at all.
  assert.match(query, /isCountryScopedQuery\(f\) \|\| isDefaultShapeQuery\(f\)/);
});
