import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_AGE_DAYS } from '../src/corpus/types.js';

/**
 * The purge window must stay inside the serving window, and the purge has to
 * actually run.
 *
 * Two separate bugs, a day apart, both of which filled the database.
 *
 * The first: PURGE_AFTER_DAYS was 45 while the site only serves MAX_AGE_DAYS
 * (21), so for 24 days every closed posting was invisible to visitors and
 * undeleted on disk. n_tup_del on `jobs` was 0, lifetime.
 *
 * The second: with the window fixed, the delete was still one statement over
 * 61,614 rows with a cascade into job_embedding, run by all four shards at once
 * against an 8-second statement_timeout inherited from `authenticator`. Every
 * shard of every run logged `canceling statement due to statement timeout`, and
 * because a failed purge must never fail a crawl, the runs stayed green while
 * the database crossed its ceiling. Green builds, zero rows deleted, a day lost.
 *
 * Read out of the source rather than exported: these constants are private, and
 * making them public just to test them invites setting them from elsewhere.
 */
const feedSource = readFileSync(new URL('../src/corpus/db-feed.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../src/cli/crawl-db.ts', import.meta.url), 'utf8');

/**
 * Comments stripped before matching. A "must not appear" assertion read against
 * the raw file fails on the comment explaining why the thing is absent — the
 * absence is documented exactly where it happened.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/.*$/gm, ' ');
const feed = strip(feedSource);
const cli = strip(cliSource);

function constant(name: string): number {
  const m = new RegExp(`^const ${name} = ([\\d_]+);$`, 'm').exec(feed);
  assert.ok(m, `${name} is no longer a plain literal — update this test`);
  return Number(m[1]!.replace(/_/g, ''));
}

test('closed jobs are purged well before the serving window ends', () => {
  const purge = constant('PURGE_AFTER_DAYS');
  assert.ok(
    purge < MAX_AGE_DAYS,
    `PURGE_AFTER_DAYS (${purge}) must be under MAX_AGE_DAYS (${MAX_AGE_DAYS}); ` +
      'above it, rows are unservable and undeleted and the disk fills',
  );
  // And not so eager that a wrongly-closed posting cannot be recovered by hand.
  assert.ok(purge >= 3, `PURGE_AFTER_DAYS (${purge}) leaves no room to undo a bad close`);
});

test('the purge only ever deletes rows that are closed AND past the window', () => {
  assert.match(feed, /\.not\('closed_at', 'is', null\)/);
  assert.match(feed, /\.lt\('closed_at', purgeBefore\)/);
  // An open posting must never be reachable by this delete, however old.
  assert.doesNotMatch(feed, /\.lt\('posted_at', purgeBefore\)/);
});

test('the delete is chunked, never one statement over the whole backlog', () => {
  // The bug: `.delete()` filtered by predicate deletes everything matching in a
  // single statement. Deleting by key in FILTER_CHUNK-sized batches is what
  // keeps each statement inside the 8-second timeout.
  assert.match(feed, /\.delete\(\)\s*\.in\('key', chunk\)/);
  assert.match(feed, /i \+= FILTER_CHUNK/);
  assert.doesNotMatch(feed, /\.delete\(\{ count: 'exact' \}\)\s*\.not\('closed_at'/);
});

test('the purge is bounded by both a row budget and a clock', () => {
  const budget = constant('PURGE_BUDGET');
  assert.ok(budget > 0 && budget <= 50_000, `PURGE_BUDGET (${budget}) is not a sane per-run cap`);
  const deadline = constant('PURGE_DEADLINE_MS');
  assert.ok(deadline > 0 && deadline <= 300_000, `PURGE_DEADLINE_MS (${deadline}) is not a sane cap`);
  // A budget alone is not enough: the rows could be cheap and the database slow.
  assert.match(feed, /Date\.now\(\) < stopBy/);
});

test('the keys it reads never exceed what PostgREST will return', () => {
  // A select asking for more than 1000 silently returns 1000, which would make
  // the loop read the same page forever if the budget were larger than the cap.
  assert.ok(constant('PURGE_READ') <= 1000, 'PURGE_READ above PostgREST 1000-row cap');
});

test('only one shard purges', () => {
  // Four shards deleting the same rows spent the whole timeout on lock
  // contention. An unsharded run still purges.
  assert.match(cli, /purge: !shard \|\| shard\.index === 0/);
  assert.match(feed, /\{ purge = true \}: \{ purge\?: boolean \} = \{\}/);
  assert.match(feed, /if \(purge\) await purgeClosed\(client\)/);
});

test('a failed purge is loud, and never fails a crawl that already wrote', () => {
  // Reclaiming space is housekeeping: a crawl that read 240,000 postings and
  // stored them correctly must not go red because the cleanup errored. But it
  // must say so — the single-statement version failed silently for a full day.
  assert.match(feed, /console\.error\('purge failed reading keys:'/);
  assert.match(feed, /console\.error\(`purge failed for \$\{chunk\.length\} jobs/);
  assert.doesNotMatch(feed, /throw new Error\([^)]*purge/i);
  // And a line on every run, including zero, so "nothing to do" and "broken
  // again" cannot look the same from the outside.
  assert.match(feed, /console\.log\(`purged \$\{purged\} jobs closed before/);
});
