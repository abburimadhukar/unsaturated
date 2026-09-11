import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describePlan,
  planEmbeddings,
  type Candidate,
  type Stored,
} from '../src/matching/plan.js';

/**
 * Restraint, which is the whole problem.
 *
 * The digest can only be built during a crawl — there is no `description` column
 * and never has been, so a backfill over the database is impossible. That puts
 * embedding inside the hourly crawl, which re-upserts every job it finds every
 * run: 65,818 open jobs across roughly 11 runs a day.
 *
 * Embedding what it sees each time would be ~724,000 calls a day against a free
 * allowance covering about 43,000. So the rule is: embed a job once, and never
 * again unless its digest actually changed. These tests are that rule.
 */

const c = (key: string, hash: string, digest = `digest for ${key}`): Candidate => ({
  key,
  digest,
  hash,
});
const storedAs = (...rows: [string, string, string?][]): Map<string, Stored> =>
  new Map(rows.map(([key, hash, model]) => [key, { hash, model: model ?? 'bge-small' }]));

const MODEL = 'bge-small';
const PLENTY = 10_000;

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('a job with no vector is embedded', () => {
  const plan = planEmbeddings([c('a', 'h1')], new Map(), MODEL, PLENTY);
  assert.deepEqual(plan.toEmbed.map((x) => x.key), ['a']);
  assert.equal(plan.reasons.missing, 1);
});

test('AN UNCHANGED JOB IS NEVER EMBEDDED AGAIN', () => {
  // The one that matters. Getting this wrong is 724,000 calls a day against an
  // allowance of 43,000 — the feature would stop working within hours and stay
  // broken.
  const plan = planEmbeddings([c('a', 'h1')], storedAs(['a', 'h1']), MODEL, PLENTY);
  assert.deepEqual(plan.toEmbed, []);
  assert.equal(plan.unchanged, 1);
});

test('a steady-state run sends nothing at all', () => {
  const jobs = Array.from({ length: 500 }, (_, i) => c(`k${i}`, `h${i}`));
  const stored = storedAs(...jobs.map((j) => [j.key, j.hash] as [string, string]));
  const plan = planEmbeddings(jobs, stored, MODEL, PLENTY);
  assert.equal(plan.toEmbed.length, 0);
  assert.equal(plan.unchanged, 500);
  assert.equal(plan.deferred, 0);
  assert.match(describePlan(plan), /nothing to do \(500 unchanged\)/);
});

test('a changed digest is re-embedded', () => {
  // The employer edited the ad, or it picked up a skill it did not name before.
  const plan = planEmbeddings([c('a', 'NEW')], storedAs(['a', 'OLD']), MODEL, PLENTY);
  assert.deepEqual(plan.toEmbed.map((x) => x.key), ['a']);
  assert.equal(plan.reasons.changed, 1);
  assert.equal(plan.unchanged, 0);
});

test('A MODEL CHANGE RE-EMBEDS, BECAUSE THE VECTORS ARE NOT COMPARABLE', () => {
  // Two models put the same text in different places. Mixing them silently would
  // make every score between them meaningless, and nothing about the output
  // would look wrong.
  const plan = planEmbeddings([c('a', 'h1')], storedAs(['a', 'h1', 'old-model']), MODEL, PLENTY);
  assert.deepEqual(plan.toEmbed.map((x) => x.key), ['a']);
  assert.equal(plan.reasons.remodelled, 1);
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

test('the budget is a hard ceiling', () => {
  const jobs = Array.from({ length: 50 }, (_, i) => c(`k${i}`, `h${i}`));
  const plan = planEmbeddings(jobs, new Map(), MODEL, 10);
  assert.equal(plan.toEmbed.length, 10);
  assert.equal(plan.deferred, 40);
});

test('NEVER-EMBEDDED JOBS COME FIRST WHEN THE BUDGET IS TIGHT', () => {
  // A job with no vector has no score at all. A job whose digest shifted still
  // has a usable one, so it can wait for the next run — eleven a day.
  const jobs = [c('changed', 'NEW'), c('fresh', 'h2'), c('remodel', 'h3')];
  const stored = storedAs(['changed', 'OLD'], ['remodel', 'h3', 'old-model']);
  const plan = planEmbeddings(jobs, stored, MODEL, 1);
  assert.deepEqual(plan.toEmbed.map((x) => x.key), ['fresh']);
  assert.equal(plan.deferred, 2);
});

test('re-models are the least urgent of the three', () => {
  const jobs = [c('remodel', 'h1'), c('changed', 'NEW'), c('fresh', 'h3')];
  const stored = storedAs(['remodel', 'h1', 'old-model'], ['changed', 'OLD']);
  const plan = planEmbeddings(jobs, stored, MODEL, 2);
  assert.deepEqual(plan.toEmbed.map((x) => x.key), ['fresh', 'changed']);
});

test('a budget of zero sends nothing but still reports what was wanted', () => {
  // How a throttled run must look: silence and "0 to send" are different facts.
  const plan = planEmbeddings([c('a', 'h1'), c('b', 'h2')], new Map(), MODEL, 0);
  assert.deepEqual(plan.toEmbed, []);
  assert.equal(plan.deferred, 2);
  assert.match(describePlan(plan), /0 to send.*2 deferred/);
});

test('a negative budget is treated as zero rather than reversing the slice', () => {
  const plan = planEmbeddings([c('a', 'h1')], new Map(), MODEL, -5);
  assert.deepEqual(plan.toEmbed, []);
  assert.equal(plan.deferred, 1);
});

// ---------------------------------------------------------------------------
// Not spending budget twice
// ---------------------------------------------------------------------------

test('the same job twice in one batch is embedded once', () => {
  const plan = planEmbeddings([c('a', 'h1'), c('a', 'h1')], new Map(), MODEL, PLENTY);
  assert.equal(plan.toEmbed.length, 1);
});

test('a duplicate with a DIFFERENT hash still only counts once', () => {
  // First wins. Sending both would pay twice and leave whichever landed last.
  const plan = planEmbeddings([c('a', 'h1'), c('a', 'h2')], new Map(), MODEL, PLENTY);
  assert.equal(plan.toEmbed.length, 1);
  assert.equal(plan.toEmbed[0]?.hash, 'h1');
});

test('an empty digest is skipped rather than embedded', () => {
  // Cannot happen for a real job — digestFor always returns at least the title,
  // and title is NOT NULL — so this is the guard for a caller that got it wrong.
  const plan = planEmbeddings(
    [{ key: 'a', digest: '', hash: 'h1' }, { key: 'b', digest: '   ', hash: 'h2' }],
    new Map(),
    MODEL,
    PLENTY,
  );
  assert.deepEqual(plan.toEmbed, []);
  assert.equal(plan.unchanged, 0, 'skipped is not the same as unchanged');
});

test('a missing hash is skipped, since there would be nothing to compare later', () => {
  const plan = planEmbeddings([{ key: 'a', digest: 'real text', hash: '' }], new Map(), MODEL, PLENTY);
  assert.deepEqual(plan.toEmbed, []);
});

test('nothing in, nothing out', () => {
  const plan = planEmbeddings([], new Map(), MODEL, PLENTY);
  assert.deepEqual(plan.toEmbed, []);
  assert.equal(plan.unchanged, 0);
  assert.equal(plan.deferred, 0);
});

// ---------------------------------------------------------------------------
// The log line, because it is the only way anyone sees this working
// ---------------------------------------------------------------------------

test('the log line distinguishes idle from throttled', () => {
  const idle = planEmbeddings([c('a', 'h1')], storedAs(['a', 'h1']), MODEL, PLENTY);
  const throttled = planEmbeddings([c('a', 'h1'), c('b', 'h2')], new Map(), MODEL, 1);

  assert.match(describePlan(idle), /nothing to do/);
  assert.doesNotMatch(describePlan(idle), /deferred/);

  assert.match(describePlan(throttled), /1 to send/);
  assert.match(describePlan(throttled), /1 deferred to the next run/);
  assert.notEqual(describePlan(idle), describePlan(throttled));
});

test('the log line names every reason present, and none that is absent', () => {
  const plan = planEmbeddings(
    [c('fresh', 'h1'), c('changed', 'NEW')],
    storedAs(['changed', 'OLD']),
    MODEL,
    PLENTY,
  );
  const line = describePlan(plan);
  assert.match(line, /1 new/);
  assert.match(line, /1 changed/);
  assert.doesNotMatch(line, /re-modelled/, 'no re-models happened, so none is mentioned');
});

// ---------------------------------------------------------------------------
// The arithmetic that makes this affordable
// ---------------------------------------------------------------------------

test('A FULL CRAWL OF AN ALREADY-EMBEDDED CORPUS COSTS NOTHING', () => {
  // 6,700 jobs is roughly one shard's share of 65,818 across four shards. Eleven
  // runs a day over an embedded corpus must send zero, or the daily allowance is
  // gone before lunch.
  const jobs = Array.from({ length: 6_700 }, (_, i) => c(`k${i}`, `h${i}`));
  const stored = storedAs(...jobs.map((j) => [j.key, j.hash] as [string, string]));

  let sent = 0;
  for (let run = 0; run < 11; run++) {
    sent += planEmbeddings(jobs, stored, MODEL, 2_000).toEmbed.length;
  }
  assert.equal(sent, 0, 'eleven runs over an embedded corpus sent ' + sent);
});
