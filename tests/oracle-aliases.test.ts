import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ALIAS_PREFIX, aliasReason, aliasesOf, pickKeeper, sameBoard } from '../src/discovery/aliases.js';
import { withoutOracleAliases, type FetchIds } from '../src/discovery/alias-guard.js';
import { isDeliberateRetirement } from '../src/corpus/revival.js';
import type { OpenBoard } from '../src/discovery/opendata.js';

/**
 * Oracle sites that are the same board under two addresses.
 *
 * Retiring a board is the one thing this project refuses to do on a hunch, so
 * the rule under test is strict: every posting id equal, or it stays.
 */

const ids = (...xs: (string | number)[]) => new Set(xs.map(String));

// ------------------------------------------------------------------ the rule

test('identical id sets are one board', () => {
  assert.equal(sameBoard(ids(1, 2, 3), ids(3, 2, 1)), true);
});

test('one posting of difference is two boards', () => {
  // emit/CX and emit/CX_2001 (WSP) share their whole first page and differ by
  // seventeen postings. Both stay.
  assert.equal(sameBoard(ids(1, 2, 3), ids(1, 2, 3, 4)), false);
  assert.equal(sameBoard(ids(1, 2, 3), ids(1, 2, 9)), false);
});

test('a site that could not be read is a copy of nothing', () => {
  // Failing to read a site is not evidence about it. Two unreadable siblings
  // must not be declared identical because both came back empty.
  assert.equal(sameBoard(ids(), ids()), false);
  assert.deepEqual(aliasesOf([{ site: 'CX', ids: ids() }, { site: 'CX_1', ids: ids() }]), []);
});

test('the named site is kept and the default CX address retired', () => {
  // Oracle's own UI redirects CX to the named site.
  assert.equal(pickKeeper(['CX', 'CX_3001']), 'CX_3001');
  assert.equal(pickKeeper(['CX', 'gallifordtrycareers']), 'gallifordtrycareers');
  // Among named sites the choice is stable, so two runs never disagree.
  assert.equal(pickKeeper(['CX_2', 'CX_1']), 'CX_1');
  assert.equal(pickKeeper(['CX']), 'CX');
});

test('a tenant with two real boards and one copy loses only the copy', () => {
  const out = aliasesOf([
    { site: 'CX', ids: ids(1, 2, 3) },
    { site: 'CX_1', ids: ids(1, 2, 3) }, // same pool as CX
    { site: 'Lucy_Zodion', ids: ids(7, 8) }, // a genuinely different board
  ]);
  assert.deepEqual(out, [{ site: 'CX', keptSite: 'CX_1' }]);
});

test('three copies keep one', () => {
  const out = aliasesOf([
    { site: 'CX', ids: ids(1, 2) },
    { site: 'CX_2', ids: ids(1, 2) },
    { site: 'CX_1', ids: ids(1, 2) },
  ]);
  assert.deepEqual(
    out.map((o) => o.site).sort(),
    ['CX', 'CX_2'],
  );
  assert.ok(out.every((o) => o.keptSite === 'CX_1'));
});

// ------------------------------------------------------------------ retirement

test('an alias retirement is deliberate, so revival never undoes it', () => {
  assert.equal(isDeliberateRetirement(aliasReason('CX_1')), true);
  assert.ok(aliasReason('CX_1').startsWith(ALIAS_PREFIX));
  // The existing kind still counts, and an ordinary failure still does not.
  assert.equal(isDeliberateRetirement('duplicate spelling of cleric'), true);
  assert.equal(isDeliberateRetirement('HTTP 404'), false);
  assert.equal(isDeliberateRetirement('upstream said: duplicate site of x'), false);
});

test('the retirement statement only touches active oracle rows', () => {
  const src = readFileSync(new URL('../src/cli/oracle-aliases.ts', import.meta.url), 'utf8');
  assert.match(src, /b\.provider = 'oracle' and b\.active/);
  assert.match(src, /set active = false, last_error = v\.reason/);
  assert.ok(!/\.delete\(/.test(src), 'the alias pass must retire, never delete');
});

// ------------------------------------------------------------------ discovery

const cand = (token: string, site: string) => ({
  board: { provider: 'oracle', token, company: token, extra: { host: `${token}.fa.em2.oraclecloud.com`, site } } as OpenBoard,
  jobs: 1,
});

const fakeIds =
  (table: Record<string, Set<string>>): FetchIds =>
  async (b) =>
    table[`${b.token}/${b.extra?.site}`] ?? new Set();

test('a newcomer that copies a registered site is not stored', async () => {
  const registered = [{ provider: 'oracle', token: 'eofh', extra: { site: 'CX_3001' } }];
  const live = [cand('eofh', 'CX')];
  const { kept, dropped } = await withoutOracleAliases(
    live,
    registered,
    fakeIds({ 'eofh/CX': ids(1, 2), 'eofh/CX_3001': ids(1, 2) }),
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped[0]?.copyOf, 'CX_3001');
});

test('a newcomer with different postings is stored', async () => {
  const registered = [{ provider: 'oracle', token: 'emit', extra: { site: 'CX' } }];
  const { kept } = await withoutOracleAliases(
    [cand('emit', 'CX_2001')],
    registered,
    fakeIds({ 'emit/CX': ids(1, 2, 3), 'emit/CX_2001': ids(1, 2) }),
  );
  assert.equal(kept.length, 1);
});

test('a brand-new tenant arriving with its CX alias keeps only the named site', async () => {
  const { kept, dropped } = await withoutOracleAliases(
    [cand('newt', 'CX'), cand('newt', 'CX_1')],
    [],
    fakeIds({ 'newt/CX': ids(5, 6), 'newt/CX_1': ids(5, 6) }),
  );
  assert.deepEqual(kept.map((k) => k.board.extra?.site), ['CX_1']);
  assert.equal(dropped[0]?.candidate.board.extra?.site, 'CX');
});

test('a tenant with one site costs no requests, and other vendors are untouched', async () => {
  let asked = 0;
  const counting: FetchIds = async () => {
    asked++;
    return ids(1);
  };
  const gh = { board: { provider: 'greenhouse', token: 'stripe', company: 'Stripe' } as OpenBoard, jobs: 3 };
  const { kept } = await withoutOracleAliases([cand('solo', 'CX'), gh], [], counting);
  assert.equal(kept.length, 2);
  assert.equal(asked, 0);
});

test('an unreadable newcomer is stored rather than guessed a copy', async () => {
  const registered = [{ provider: 'oracle', token: 'down', extra: { site: 'CX_1' } }];
  const { kept } = await withoutOracleAliases(
    [cand('down', 'CX')],
    registered,
    fakeIds({ 'down/CX_1': ids(1) }), // down/CX reads as empty
  );
  assert.equal(kept.length, 1);
});

test('discovery counts deliberately retired boards as known', () => {
  const src = readFileSync(new URL('../src/cli/harvest-cc.ts', import.meta.url), 'utf8');
  assert.match(src, /readDeliberateRetirements/);
  assert.match(src, /\[\.\.\.registered, \.\.\.retiredOnPurpose\]\.map\(keyOf\)/);
  assert.match(src, /withoutOracleAliases\(/);
});
