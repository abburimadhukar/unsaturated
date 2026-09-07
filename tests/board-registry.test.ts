import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mergeBoards } from '../src/corpus/boards.js';
import { blockKey } from '../src/corpus/blocklist.js';
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
