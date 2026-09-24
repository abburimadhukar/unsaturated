import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { SEAT_LIMIT } from '../src/state/seats.js';
import { SEAT_LIMIT as FROM_AUTH } from '../src/state/auth.js';

/**
 * The seat cap exists twice: the number the site shows and the number the
 * database trigger enforces. If they differ, one of two things goes wrong:
 *
 *   site > database   a person is emailed a sign-in link, clicks it, and is
 *                     refused a seat — the worst version, because it looks
 *                     like it worked.
 *   site < database   the site says "full" while there is room.
 *
 * Raised from 4 to 6 on 24 Sep 2026.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** The latest migration that defines the trigger is the one in force. */
function enforcedLimit(): number {
  const dir = new URL('../src/db/migrations/', import.meta.url);
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => /create or replace function public\.enforce_seat_limit/i.test(read(`../src/db/migrations/${f}`)));
  assert.ok(defining.length > 0, 'no migration defines enforce_seat_limit');
  const sql = read(`../src/db/migrations/${defining.at(-1)}`);
  const m = /if taken >= (\d+) then/.exec(sql);
  assert.ok(m, 'could not read the limit out of the trigger body');
  return Number(m[1]);
}

test('the site and the database agree on the seat limit', () => {
  assert.equal(SEAT_LIMIT, enforcedLimit());
});

test('auth.ts re-exports the same number rather than keeping its own', () => {
  assert.equal(FROM_AUTH, SEAT_LIMIT);
  assert.doesNotMatch(read('../src/state/auth.ts'), /export const SEAT_LIMIT\s*=/);
});

test('no page hard-codes the old number', () => {
  // The three pages that tell people how many seats there are. Each now reads
  // SEAT_LIMIT; a literal here would be the next "4" someone forgets to change.
  for (const page of ['../app/admin/page.tsx', '../app/account/page.tsx', '../app/signin/page.tsx']) {
    const src = read(page);
    assert.match(src, /import \{ SEAT_LIMIT \} from '\.\.\/\.\.\/src\/state\/seats\.js'/, page);
    assert.doesNotMatch(src, /\bof 4 seats\b|\bfour seats\b|\bFour accounts\b/i, page);
  }
});

test('the browser-safe file imports nothing', () => {
  // The reason seats.ts exists: pages must be able to read the number without
  // pulling supabase-js and the environment into the client bundle.
  assert.doesNotMatch(read('../src/state/seats.ts'), /^import /m);
});
