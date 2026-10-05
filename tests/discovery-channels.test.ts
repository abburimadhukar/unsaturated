import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { freshBoards } from '../src/discovery/store-verified.js';
import { boardIdentity } from '../src/corpus/board-store.js';
import type { OpenBoard } from '../src/discovery/opendata.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * The three dormant channels — Hacker News, careers-page detection, and the
 * second open dataset — all produced good candidates and wrote them to
 * discovered-boards.json, which stopped being the registry when the boards table
 * landed. So each had contributed zero rows to what the crawl reads. These tests
 * pin the fix: they write to the DB with a source label, and the cross-provider
 * ones are actually scheduled.
 */

// ------------------------------------------------------- fresh-candidate rule

test('freshBoards excludes what the registry already holds, case-insensitively', () => {
  // The APIs fold case — greenhouse/stripe and greenhouse/Stripe are one board —
  // so the identity used here must fold it too, or a known board reads as new.
  const known = new Set([boardIdentity({ provider: 'greenhouse', token: 'stripe' })]);
  const candidates: OpenBoard[] = [
    { provider: 'greenhouse', token: 'Stripe', company: 'Stripe' },
    { provider: 'greenhouse', token: 'vercel', company: 'Vercel' },
  ];
  const fresh = freshBoards(candidates, known);
  assert.deepEqual(fresh.map((b) => b.token), ['vercel']);
});

test('freshBoards de-duplicates the incoming list by the same identity', () => {
  const fresh = freshBoards(
    [
      { provider: 'lever', token: 'acme', company: 'Acme' },
      { provider: 'lever', token: 'ACME', company: 'Acme' },
    ],
    new Set(),
  );
  assert.equal(fresh.length, 1);
});

test('a Workday tenant keeps each of its sites — identity includes the site', () => {
  const fresh = freshBoards(
    [
      { provider: 'workday', token: 'nshe', company: 'NSHE', extra: { site: 'UNR-external' } },
      { provider: 'workday', token: 'nshe', company: 'NSHE', extra: { site: 'GBC-external' } },
    ],
    new Set(),
  );
  assert.equal(fresh.length, 2);
});

// --------------------------------------------------- the store path is the DB

test('the store helper asks the registry and refuses to run blind', () => {
  // Verifying against an unknown registry would treat every board on earth as
  // new and re-add the ones deliberately retired.
  const src = read('../src/discovery/store-verified.ts');
  assert.match(src, /readActiveBoards/);
  assert.match(src, /Refusing to verify against an unknown registry/);
  // It must use the store's own identity, not a private copy that can drift.
  assert.match(src, /boardIdentity/);
  assert.match(src, /upsertBoards/);
});

test('the HN DB path stores with source "hn"', () => {
  const src = read('../src/cli/harvest-hn.ts');
  assert.match(src, /verifyAndStore/);
  assert.match(src, /source: 'hn'/);
});

test('the careers DB path stores with source "careers"', () => {
  const src = read('../src/cli/detect-careers.ts');
  assert.match(src, /verifyAndStore/);
  assert.match(src, /source: 'careers'/);
});

// ------------------------------------------------- the workflow actually runs

test('HN and careers detection run in the weekly discovery, not just in the code', () => {
  // A harvester nobody schedules is a harvester that never runs — the same
  // lesson Rippling and the Archive each taught once.
  const wf = read('../.github/workflows/discover.yml');
  assert.match(wf, /npm run harvest:hn -- --store db/);
  assert.match(wf, /npm run detect -- --store db/);
});

test('each cross-provider channel is pinned to one shard, so it runs once', () => {
  // Both span every provider. Left ungated they would run once per vendor shard
  // — eleven duplicate HN harvests in a scheduled run.
  const wf = read('../.github/workflows/discover.yml');
  const hn = wf.slice(wf.indexOf('Harvest boards from Hacker News'));
  assert.match(hn.slice(0, 500), /matrix\.provider == 'lever'/);
  const careers = wf.slice(wf.indexOf('Detect ATS boards from careers pages'));
  assert.match(careers.slice(0, 500), /matrix\.provider == 'teamtailor'/);
});

test('a failing new channel cannot take a vendor harvest red with it', () => {
  // The same rule the Archive step follows: a new, noisier channel must not turn
  // a green Common Crawl harvest into a failed run nobody then trusts.
  const wf = read('../.github/workflows/discover.yml');
  for (const name of [
    'Harvest boards from Hacker News',
    'Detect ATS boards from careers pages',
    'Seed new boards from the open ATS dataset',
  ]) {
    const step = wf.slice(wf.indexOf(name));
    assert.match(step.slice(0, 500), /continue-on-error: true/, name);
  }
});

test('the open-dataset catch-up is wired per provider, so the backlog drains itself', () => {
  // The whole point of #3: nobody runs the 19k import by hand. Each provider
  // shard pulls its own vendor's net-new from the dataset, capped so the run
  // stays inside the time ceiling.
  const wf = read('../.github/workflows/discover.yml');
  assert.match(wf, /npm run dataset:diff -- --provider \$\{\{ matrix\.provider \}\} --verify \d+/);
  // And the ceiling was raised to carry the third verify pass.
  const timeout = Number(/timeout-minutes: (\d+)/.exec(wf)?.[1] ?? 0);
  assert.ok(timeout >= 200, `timeout-minutes is ${timeout}, too tight for three verify passes`);
});

// ------------------------------------------------------------- the diff tool

test('the dataset diff is runnable and defaults to report-only', () => {
  const pkg = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts['dataset:diff'], 'dataset:diff script is missing');
  const cli = read('../src/cli/dataset-diff.ts');
  // verify defaults to 0 — the report writes nothing and needs no secret key.
  assert.match(cli, /arg\('verify'\) \?\? '0'/);
});
