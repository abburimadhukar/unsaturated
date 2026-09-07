import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mergeBoards } from '../src/corpus/boards.js';
import { blockKey } from '../src/corpus/blocklist.js';
import { isTransientWriteError, upsertInChunks } from '../src/corpus/db-feed.js';
import type { CorpusBoard } from '../src/corpus/types.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const board = (provider: string, token: string, company = token): CorpusBoard =>
  ({ provider, token, company }) as CorpusBoard;

// ---------------------------------------------------------------------------
// The crawl list
//
// The seed file and the registry disagreed on case, and nothing folded it. The
// file held `vultr`, the registry `Vultr`, and the crawler fetched both — so
// every posting was stored twice under two job keys and shown twice on the
// site. Measured 7 Sep 2026: Snowflake 81 jobs twice, Canva 44 twice,
// TogetherAI 10 twice, across 89 pairs.
// ---------------------------------------------------------------------------

test('a board spelled two ways is one board, not two', () => {
  const merged = mergeBoards([board('ashby', 'vultr')], [board('ashby', 'Vultr')]);
  assert.equal(merged.size, 1, 'vultr and Vultr are the same board');
});

test('the registry copy wins, because it carries the health state', () => {
  const merged = mergeBoards(
    [board('ashby', 'snowflake', 'from the file')],
    [board('ashby', 'Snowflake', 'from the registry')],
  );
  assert.equal([...merged.values()][0]?.company, 'from the registry');
});

test('genuinely different boards are both kept', () => {
  const merged = mergeBoards(
    [board('ashby', 'vultr'), board('greenhouse', 'vultr')],
    [board('ashby', 'linear')],
  );
  assert.equal(merged.size, 3, 'same token under different providers is two boards');
});

test('a board only the file knows is still crawled', () => {
  // Deleting the file must never be what removes a board from the crawl, and
  // until every entry is adopted the file is still load-bearing.
  const merged = mergeBoards([board('greenhouse', 'cloudflare')], [board('ashby', 'linear')]);
  assert.equal(merged.size, 2);
  assert.ok([...merged.keys()].includes('greenhouse:cloudflare'));
});

// ---------------------------------------------------------------------------
// Blocking
// ---------------------------------------------------------------------------

test('a block cannot be walked around by changing the case', () => {
  // These APIs are case-insensitive, so a case-sensitive block was a block that
  // the web archive routinely supplies the way around: it hands us both
  // spellings of the same company.
  assert.equal(blockKey('lever', 'GlobalEliteCareers'), blockKey('lever', 'globalelitecareers'));
  assert.equal(blockKey('ukg', 'OLL1000OLLIE'), 'ukg:oll1000ollie');
});

test('blocking still distinguishes providers', () => {
  assert.notEqual(blockKey('lever', 'acme'), blockKey('ashby', 'acme'));
});

// ---------------------------------------------------------------------------
// Discovery's idea of "already registered"
// ---------------------------------------------------------------------------

test('discovery asks the registry, not the crawl list', () => {
  // harvest-cc called loadBoardsAsync(), which merges the seed file. 1,287 of
  // the file's entries had no row in `boards`, so every one was reported as
  // "already registered" and skipped before verification — for a week. They
  // were crawled, so no jobs were lost, but nothing could retire, re-verify or
  // dedupe them, because all of that keys off a row in `boards`.
  const src = read('../src/cli/harvest-cc.ts');
  assert.ok(
    !/loadBoardsAsync\s*\(/.test(src),
    'harvest-cc must not decide what is registered from the merged crawl list',
  );
  assert.match(src, /readActiveBoards/);
});

test('an unreadable registry stops the harvest rather than flooding it', () => {
  // readActiveBoards returns null when it cannot read. Treating that as "no
  // boards registered" would re-verify the whole corpus and re-add everything
  // deliberately retired.
  const src = read('../src/cli/harvest-cc.ts');
  const guard = src.slice(src.indexOf('readActiveBoards'), src.indexOf('const known'));
  assert.match(guard, /=== null/);
  assert.match(guard, /return;/);
});

test('adoption identifies a board the way the table does', () => {
  // `boards` carries unique (provider, token). harvest-cc's key also folds in
  // the Workday site, which describes what a board IS rather than what the
  // table can HOLD — using it here found 15 extra "missing" boards that were
  // really existing rows, and adopting them would have upserted onto those rows
  // and replaced the site of four live Workday boards.
  const src = read('../src/cli/boards-adopt.ts');
  const fn = src.slice(src.indexOf('const keyOf'), src.indexOf('const registeredSite'));
  assert.ok(!/extra\?\.site/.test(fn), 'adoption must key on provider:token alone');
  assert.match(fn, /toLowerCase\(\)/);
});

test('adoption paces itself even when no delay is given', () => {
  // indexOf returns -1 for a missing flag, and argv[0] is the node binary, so
  // the delay parsed to NaN and setTimeout(NaN) fires immediately — the pass
  // ran flat out against vendors that drop bursts.
  const src = read('../src/cli/boards-adopt.ts');
  const block = src.slice(src.indexOf('const delayFlag'), src.indexOf('const file ='));
  assert.match(block, /Number\.isFinite/);
  assert.match(block, /1000/);
});

// ---------------------------------------------------------------------------
// The job upsert
//
// A shard that had crawled 5,608 boards and collected 15,746 roles threw all of
// it away because one 500-row statement timed out. Twice in thirty runs, 6 and
// 7 September. The crawl was fine both times; only the write failed, and the
// run had nothing smaller to try.
// ---------------------------------------------------------------------------

const TIMEOUT = 'canceling statement due to statement timeout';

test('a statement timeout is retryable; a real fault is not', () => {
  assert.equal(isTransientWriteError(TIMEOUT), true);
  assert.equal(isTransientWriteError('deadlock detected'), true);
  assert.equal(isTransientWriteError('socket hang up'), true);
  // These must still fail on the first attempt rather than being retried
  // smaller — a smaller batch will not fix either of them.
  assert.equal(isTransientWriteError('column "sector" does not exist'), false);
  assert.equal(isTransientWriteError('duplicate key value violates unique constraint'), false);
  assert.equal(isTransientWriteError('new row violates row-level security policy'), false);
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}` }));
const noWait = async () => {};

test('every row is written when nothing goes wrong', async () => {
  const seen: number[] = [];
  const n = await upsertInChunks(rows(1200), async (c) => { seen.push(c.length); return { error: null, count: c.length }; }, { wait: noWait });
  assert.equal(n, 1200);
  assert.deepEqual(seen, [500, 500, 200]);
});

test('a timeout halves the statement instead of failing the run', async () => {
  // The real shape of the failure: the database will take 250 rows but not 500.
  const written: number[] = [];
  const n = await upsertInChunks(rows(1000), async (c) => {
    if (c.length > 250) return { error: { message: TIMEOUT }, count: null };
    written.push(c.length);
    return { error: null, count: c.length };
  }, { wait: noWait });

  assert.equal(n, 1000, 'no row may be lost to a retry');
  assert.equal(written.reduce((a, b) => a + b, 0), 1000);
  assert.ok(written.every((s) => s <= 250));
});

test('nothing is skipped when only the first chunk is slow', async () => {
  let first = true;
  const got: string[] = [];
  const n = await upsertInChunks(rows(600), async (c) => {
    if (first && c.length === 500) { first = false; return { error: { message: TIMEOUT }, count: null }; }
    for (const r of c) got.push(r.key);
    return { error: null, count: c.length };
  }, { wait: noWait });
  assert.equal(n, 600);
  assert.equal(new Set(got).size, 600, 'every distinct row written exactly once');
});

test('a fault that is not a timeout fails immediately', async () => {
  let calls = 0;
  await assert.rejects(
    () => upsertInChunks(rows(600), async () => {
      calls++;
      return { error: { message: 'column "sector" does not exist' }, count: null };
    }, { wait: noWait }),
    /column "sector" does not exist/,
  );
  assert.equal(calls, 1, 'a real fault must not be retried smaller');
});

test('a database that times out on everything still fails loudly', async () => {
  // Halving must bottom out. Silently giving up would lose a shard's crawl
  // while reporting success, which is worse than the crash it replaced.
  await assert.rejects(
    () => upsertInChunks(rows(600), async () => ({ error: { message: TIMEOUT }, count: null }), { wait: noWait }),
    /statement timeout/,
  );
});

test('the retry is reported, never silent', async () => {
  const notes: string[] = [];
  await upsertInChunks(rows(300), async (c) =>
    c.length > 100 ? { error: { message: TIMEOUT }, count: null } : { error: null, count: c.length },
  { wait: noWait, onRetry: (size, next) => notes.push(`${size}->${next}`) });
  assert.ok(notes.length > 0, 'a run that had to back off must say so');
  assert.match(notes[0]!, /->/);
});
