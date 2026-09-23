import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_AGE_DAYS } from '../src/corpus/types.js';

/**
 * The purge window must stay inside the serving window.
 *
 * This is the bug that filled the database. PURGE_AFTER_DAYS was 45 while the
 * site only ever serves MAX_AGE_DAYS (21), so for 24 days every closed posting
 * was invisible to visitors and undeleted on disk. The purge's first delete was
 * scheduled for three weeks AFTER the 500 MB ceiling was reached, and Postgres
 * confirmed it had never run: n_tup_del on `jobs` was 0, lifetime.
 *
 * Read out of the source rather than exported, because the constant is private
 * and making it public just to test it would invite it being set from elsewhere.
 */
const feed = readFileSync(new URL('../src/corpus/db-feed.ts', import.meta.url), 'utf8');

function purgeAfterDays(): number {
  const m = /^const PURGE_AFTER_DAYS = (\d+);$/m.exec(feed);
  assert.ok(m, 'PURGE_AFTER_DAYS is no longer a plain literal — update this test');
  return Number(m[1]);
}

test('closed jobs are purged well before the serving window ends', () => {
  const purge = purgeAfterDays();
  assert.ok(
    purge < MAX_AGE_DAYS,
    `PURGE_AFTER_DAYS (${purge}) must be under MAX_AGE_DAYS (${MAX_AGE_DAYS}); ` +
      'above it, rows are unservable and undeleted and the disk fills',
  );
  // And not so eager that a wrongly-closed posting cannot be recovered by hand.
  assert.ok(purge >= 3, `PURGE_AFTER_DAYS (${purge}) leaves no room to undo a bad close`);
});

test('the purge only ever deletes rows that are closed AND past the window', () => {
  // Both conditions, in that order. `.lt('closed_at', ...)` alone would already
  // skip NULLs in Postgres, but the explicit .not(...is null) is what makes the
  // intent survive someone rewriting the filter later.
  assert.match(feed, /\.not\('closed_at', 'is', null\)/);
  assert.match(feed, /\.lt\('closed_at', purgeBefore\)/);
  // An open posting must never be reachable by this delete, however old.
  assert.doesNotMatch(feed, /\.lt\('posted_at', purgeBefore\)/);
});

test('a failed purge never fails a crawl that already wrote', () => {
  // Reclaiming space is housekeeping. A crawl that read 240,000 postings and
  // stored them correctly must not go red because the cleanup errored.
  const block = feed.slice(feed.indexOf('const purgeBefore'));
  assert.match(block.slice(0, 900), /purge failed:/);
  assert.doesNotMatch(block.slice(0, 900), /throw new Error\([^)]*purge/i);
});
