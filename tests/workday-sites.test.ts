import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { boardIdentity } from '../src/corpus/board-store.js';
import { closableBoards } from '../src/corpus/db-feed.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * One employer, several career sites.
 *
 * A Workday token is a TENANT, not a board. The Nevada System of Higher
 * Education is one tenant with a portal per campus, and `unique (provider,
 * token)` could hold only one of them. Measured across three discovery runs:
 * 765 live boards found and 352 stored, 843 and 414, 906 and 442 — about 430
 * verified-live boards discarded every run.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const wd = (token: string, site: string) =>
  ({ provider: 'workday', token, extra: { host: `${token}.wd1.myworkdayjobs.com`, site } });

test('two campuses of one university are two boards', () => {
  // Verified 7 Sep: these share no job ids at all. GBC-external is Great Basin
  // College with 18 jobs, UNR-external is UNR with 133.
  assert.notEqual(
    boardIdentity(wd('nshe', 'GBC-external')),
    boardIdentity(wd('nshe', 'UNR-external')),
  );
});

test('the same site written twice is still one board', () => {
  assert.equal(
    boardIdentity(wd('nshe', 'UNR-external')),
    boardIdentity(wd('NSHE', 'unr-external')),
    'token and site both fold case, as these APIs do',
  );
});

test('providers without sites are unaffected', () => {
  // Their extra carries no site, so the third part is empty and identity is
  // exactly what it was before.
  const a = boardIdentity({ provider: 'greenhouse', token: 'braze' });
  const b = boardIdentity({ provider: 'greenhouse', token: 'Braze', extra: {} });
  assert.equal(a, b);
  assert.equal(a, 'greenhouse:braze:');
  assert.notEqual(a, boardIdentity({ provider: 'ashby', token: 'braze' }));
});

// ---------------------------------------------------------------------------
// Closing — the part that could destroy live postings
// ---------------------------------------------------------------------------

const ok = (token: string, jobs = 5) => ({ provider: 'workday', token, jobs });
const failed = (token: string) => ({ provider: 'workday', token, jobs: 0, error: 'refused' });

test('a healthy board may close its own withdrawn postings', () => {
  assert.deepEqual([...closableBoards([ok('ryder')])], ['workday:ryder']);
});

test('a board that failed closes nothing', () => {
  assert.equal(closableBoards([failed('ryder')]).size, 0);
});

test('a board that returned zero jobs closes nothing', () => {
  // Unchanged from before: an empty answer is more often a soft failure than an
  // employer withdrawing every role at once.
  assert.equal(closableBoards([ok('ryder', 0)]).size, 0);
});

test('ONE campus failing protects the whole tenant', () => {
  // The reason this function exists. Both campuses write board_token `nshe`, so
  // if the successful one authorised closing, the refused one's 133 postings
  // would all be closed as withdrawn.
  const set = closableBoards([ok('nshe', 18), failed('nshe')]);
  assert.equal(set.has('workday:nshe'), false, 'a mixed tenant must never authorise closing');
});

test('both campuses succeeding does allow closing', () => {
  const set = closableBoards([ok('nshe', 18), ok('nshe', 133)]);
  assert.equal(set.has('workday:nshe'), true);
});

test('one tenant failing does not stop another from closing', () => {
  const set = closableBoards([ok('nshe', 18), failed('nshe'), ok('ryder', 40)]);
  assert.deepEqual([...set], ['workday:ryder']);
});

test('the same token under two providers stays separate', () => {
  const set = closableBoards([
    { provider: 'greenhouse', token: 'acme', jobs: 5 },
    { provider: 'ashby', token: 'acme', jobs: 0, error: 'boom' },
  ]);
  assert.deepEqual([...set], ['greenhouse:acme']);
});

test('a board with no token is ignored rather than crashing', () => {
  assert.equal(closableBoards([{ provider: 'workday', jobs: 3 }]).size, 0);
});

// ---------------------------------------------------------------------------
// The migration, and surviving the gap before it is applied
// ---------------------------------------------------------------------------

test('the migration replaces the identity rather than adding to it', () => {
  const sql = read('../src/db/migrations/2026-09-07-workday-sites.sql');
  assert.match(sql, /add column if not exists site/);
  assert.match(sql, /generated always as \(coalesce\(extra->>'site', ''\)\) stored/);
  // The old unique key MUST go, or the new one can never be reached.
  assert.match(sql, /drop constraint/);
  assert.match(sql, /create unique index if not exists boards_provider_token_site_key/);
});

test('the write survives the schema not being applied yet', () => {
  // Migrations here are run by hand, so code and schema are out of step by
  // design. Conflicting on a column that does not exist would fail every crawl
  // and every discovery run in the gap.
  const src = read('../src/corpus/board-store.ts');
  const block = src.slice(src.indexOf("let target = 'provider,token,site'"), src.indexOf('written += count'));
  assert.match(block, /provider,token,site/);
  assert.match(block, /target = 'provider,token'/, 'must fall back to the old conflict target');
  assert.match(block, /console\.error/, 'and must say so rather than degrading silently');
});

// ---------------------------------------------------------------------------
// The crawl list must carry both sites too
//
// Every stage has to agree, or the change achieves nothing. The registry can
// hold two campuses, but if the crawl list folds them back to one entry the
// crawler only ever fetches one of them.
// ---------------------------------------------------------------------------

test('the crawl list keeps both campuses of one tenant', async () => {
  const { mergeBoards } = await import('../src/corpus/boards.js');
  const merged = mergeBoards([], [
    { provider: 'workday', token: 'nshe', company: 'NSHE', extra: { site: 'GBC-external' } },
    { provider: 'workday', token: 'nshe', company: 'NSHE', extra: { site: 'UNR-external' } },
  ] as never);
  assert.equal(merged.size, 2, 'both campuses must be crawled');
});

test('the crawl list still folds a genuine duplicate', async () => {
  const { mergeBoards } = await import('../src/corpus/boards.js');
  // Same board, two spellings, no site: still one board.
  const merged = mergeBoards(
    [{ provider: 'ashby', token: 'vultr', company: 'file' }] as never,
    [{ provider: 'ashby', token: 'Vultr', company: 'registry' }] as never,
  );
  assert.equal(merged.size, 1);
  assert.equal([...merged.values()][0]?.company, 'registry');
});

test('dedupe does not treat two campuses as one company', () => {
  // Grouping on the token alone would merge them and close 133 live University
  // of Nevada postings as duplicates of Great Basin College's 18.
  const src = read('../src/cli/boards-dedupe.ts');
  const block = src.slice(src.indexOf('const groups = new Map'), src.indexOf('const dupes'));
  assert.match(block, /extra\?\.site/, 'the grouping key must include the site');
});

test('every stage agrees on what a board is', () => {
  // board-store, boards, harvest-cc and boards-dedupe all key boards. If one of
  // them leaves the site out, it silently undoes the others.
  for (const [file, where] of [
    ['../src/corpus/board-store.ts', 'boardIdentity'],
    ['../src/corpus/boards.ts', 'mergeBoards'],
    ['../src/cli/boards-dedupe.ts', 'const groups'],
    ['../src/cli/harvest-cc.ts', 'const keyOf'],
  ] as [string, string][]) {
    const src = read(file);
    const at = src.indexOf(where);
    assert.ok(at !== -1, `${where} not found in ${file}`);
    assert.match(src.slice(at, at + 700), /site/, `${where} in ${file} must account for the site`);
  }
});

// ---------------------------------------------------------------------------
// The migration runner
// ---------------------------------------------------------------------------

test('the runner refuses to guess which database it is talking to', () => {
  // config.databaseUrl falls back to a localhost Postgres that does not exist.
  // A migration that appears to succeed against a phantom database is worse
  // than one that fails, because the code then assumes a schema it has not got.
  const src = read('../src/cli/migrate.ts');
  const guard = src.slice(src.indexOf('if (!process.env.DATABASE_URL)'));
  assert.match(guard, /process\.exitCode = 1/);
  assert.ok(
    guard.indexOf('process.exitCode = 1') < guard.indexOf("import('../db/client.js')"),
    'it must refuse BEFORE opening a connection',
  );
});

test('the runner says plainly that the API key is not the database password', () => {
  // Worth spelling out: SUPABASE_SECRET_KEY grants every data operation in this
  // repo and none of the schema ones, because PostgREST has no DDL at all.
  const src = read('../src/cli/migrate.ts');
  assert.match(src, /NOT SUPABASE_SECRET_KEY/);
});

test('every migration on disk is listable', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../src/db/migrations/', import.meta.url)))
    .filter((f) => f.endsWith('.sql'));
  assert.ok(files.length >= 10, `expected the migration folder to be populated, saw ${files.length}`);
  assert.ok(files.includes('2026-09-07-workday-sites.sql'));
});

test('every write path conflicts on the identity the table actually has', () => {
  // The migration replaced unique (provider, token) with (provider, token,
  // site). A write still naming the old target fails with "no unique or
  // exclusion constraint matching the ON CONFLICT specification" — which is
  // exactly what happened to boards-adopt's dead-board path, so a board that
  // had gone was silently never written down.
  for (const file of ['../src/corpus/board-store.ts', '../src/cli/boards-adopt.ts']) {
    const src = read(file);
    // Matched on the target string itself, not on `onConflict:` — board-store
    // assigns it to a variable so it can fall back.
    assert.ok(
      src.includes("'provider,token,site'"),
      `${file} must conflict on provider,token,site`,
    );
    // A bare (provider, token) is allowed ONLY as the documented fallback for a
    // database where the migration has not landed yet.
    if (/'provider,token'/.test(src)) {
      assert.match(src, /fall(s|ing)? ?back/i, `${file} uses the old target without saying it is a fallback`);
    }
  }
});
