import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isUnfilteredQuery } from '../src/corpus/db-query.js';

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

test('only one shard refreshes it', () => {
  // Four shards computing the same global counts would be three repeats of the
  // most expensive read in the database.
  assert.match(cli, /if \(!shard \|\| shard\.index === 0\) await refreshFacetSnapshot\(\)/);
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
