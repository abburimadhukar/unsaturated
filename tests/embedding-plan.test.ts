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

const c = (
  key: string,
  hash: string,
  digest = `digest for ${key}`,
  provider = 'workday',
): Candidate => ({
  key,
  digest,
  hash,
  provider,
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

// ---------------------------------------------------------------------------
// Fair shares between vendors — the bug that cost the feature a day
// ---------------------------------------------------------------------------

/**
 * Open jobs per ATS, read from the live database on 12 September 2026.
 *
 * Kept as real numbers rather than a tidy fake because the fault only appears at
 * this shape: one vendor holding 47% of the corpus, a long tail holding less than
 * 1% each, and a budget of 1,000 against 66,978 jobs. A test with three equal
 * vendors passes whether the code is fixed or not.
 */
const CORPUS: [string, number][] = [
  ['workday', 31_390],
  ['greenhouse', 13_455],
  ['ashby', 5_776],
  ['smartrecruiters', 5_004],
  ['lever', 2_449],
  ['workable', 2_407],
  ['ukg', 2_056],
  ['rippling', 1_809],
  ['teamtailor', 1_151],
  ['bamboohr', 716],
  ['recruitee', 395],
  ['personio', 323],
  ['socrata', 37],
  ['breezy', 10],
];

const TOTAL = CORPUS.reduce((n, [, size]) => n + size, 0);
const BUDGET = 1_000;

/**
 * The corpus in the order the crawl actually hands it over.
 *
 * GROUPED BY VENDOR, because that is what the real input looks like: refreshFeed
 * sorts by saturation descending, and saturation tracks employer size closely
 * enough that the big enterprise boards occupy the entire head of the list.
 * Shuffling this input would hide the bug completely.
 */
const groupedByVendor = (): Candidate[] => {
  const out: Candidate[] = [];
  for (const [provider, size] of CORPUS) {
    for (let i = 0; i < size; i++) {
      out.push(c(`${provider}:${i}`, 'h1', `digest ${provider} ${i}`, provider));
    }
  }
  return out;
};

const countByProvider = (list: readonly Candidate[]): Map<string, number> => {
  const n = new Map<string, number>();
  for (const x of list) n.set(x.provider, (n.get(x.provider) ?? 0) + 1);
  return n;
};

test('ONE VENDOR CANNOT TAKE THE WHOLE BUDGET', () => {
  // The measured failure. Every one of the first 3,990 vectors in the live
  // database was Workday: 3,415 of its 31,390 open jobs, and zero from the other
  // thirteen vendors. The crawl log said "1,000 to send" and was correct.
  const plan = planEmbeddings(groupedByVendor(), new Map(), MODEL, BUDGET);
  const got = countByProvider(plan.toEmbed);

  assert.equal(plan.toEmbed.length, BUDGET);
  assert.notEqual(got.get('workday'), BUDGET, 'Workday took the entire budget again');

  const fair = Math.round((BUDGET * 31_390) / TOTAL); // ~469
  assert.ok(
    got.get('workday')! < fair * 1.3,
    `Workday took ${got.get('workday')} of ${BUDGET}, fair share is about ${fair}`,
  );
});

test('the vendors that were getting NOTHING now get a share', () => {
  const plan = planEmbeddings(groupedByVendor(), new Map(), MODEL, BUDGET);
  const got = countByProvider(plan.toEmbed);

  // Every vendor holding at least 1% of the corpus. All of these sat at exactly
  // zero vectors while Workday filled, and Greenhouse alone is 13,455 jobs.
  for (const [provider, size] of CORPUS) {
    if (size / TOTAL < 0.01) continue;
    assert.ok((got.get(provider) ?? 0) > 0, `${provider} (${size} jobs) still got nothing`);
  }

  const greenhouse = Math.round((BUDGET * 13_455) / TOTAL); // ~201
  assert.ok(
    got.get('greenhouse')! > greenhouse * 0.7,
    `greenhouse got ${got.get('greenhouse')}, expected about ${greenhouse}`,
  );
});

test('no vendor takes much more than the share of the work it holds', () => {
  // The general property, rather than a list of the vendors that happened to
  // break. Proportional shares are what make every vendor finish at about the
  // same time instead of the largest one finishing last.
  const plan = planEmbeddings(groupedByVendor(), new Map(), MODEL, BUDGET);
  const got = countByProvider(plan.toEmbed);

  for (const [provider, size] of CORPUS) {
    const fair = (BUDGET * size) / TOTAL;
    const mine = got.get(provider) ?? 0;
    // +2 of slack so a vendor whose fair share is a fraction of one job is not
    // judged against zero.
    assert.ok(
      mine <= fair * 1.5 + 2,
      `${provider} took ${mine} of ${BUDGET}; its share of the work is ${fair.toFixed(1)}`,
    );
  }
});

test('A KNOWN CONSEQUENCE: the two smallest vendors wait for a later run', () => {
  // Honest about what proportional allocation does at the bottom end. breezy has
  // 10 open jobs and socrata 37, so their fair share of a 1,000 budget is under
  // one job and they are legitimately skipped this run.
  //
  // Recorded rather than fixed because it self-corrects: the corpus only has to
  // fill once, every run shifts the proportions, and a vendor with 10 jobs is
  // complete the moment it gets a single share. Reserving a slot per vendor would
  // take it from the 13,455 Greenhouse jobs that have no score at all.
  const plan = planEmbeddings(groupedByVendor(), new Map(), MODEL, BUDGET);
  const got = countByProvider(plan.toEmbed);
  assert.equal(got.get('breezy') ?? 0, 0, 'breezy now fits, so update this note');
  assert.ok(plan.deferred > 0, 'the rest must be waiting, not lost');
});

test('URGENCY STILL OUTRANKS FAIRNESS', () => {
  // The mistake that would look like a simplification: interleaving the three
  // tiers together instead of each one separately. A job with no vector has no
  // match score at all; a job whose digest shifted still has a usable one. So one
  // vendor's never-embedded jobs must beat another vendor's re-embeds, even
  // though that is "unfair" by vendor.
  const candidates = [
    ...Array.from({ length: 5 }, (_, i) => c(`new:${i}`, 'h1', 'd', 'greenhouse')),
    ...Array.from({ length: 500 }, (_, i) => c(`old:${i}`, 'NEW', 'd', 'workday')),
  ];
  const stored = new Map(
    Array.from({ length: 500 }, (_, i) => [`old:${i}`, { hash: 'OLD', model: MODEL }] as const),
  );

  const plan = planEmbeddings(candidates, stored, MODEL, 5);
  assert.deepEqual(
    plan.toEmbed.map((x) => x.provider),
    ['greenhouse', 'greenhouse', 'greenhouse', 'greenhouse', 'greenhouse'],
    'a vendor with no vectors at all waited behind another vendor re-embedding',
  );
});

// ---------------------------------------------------------------------------
// Making it visible, which is why it survived a day
// ---------------------------------------------------------------------------

test('THE LOG LINE SAYS HOW MANY VENDORS WERE REACHED', () => {
  // The whole reason this went unnoticed: a run covering one vendor and a run
  // covering fourteen printed the same line.
  const plan = planEmbeddings(groupedByVendor(), new Map(), MODEL, BUDGET);
  assert.ok(plan.providers > 1, `only reached ${plan.providers} vendor`);
  assert.match(describePlan(plan), new RegExp(`across ${plan.providers} vendors`));
});

test('the vendor count describes what is SENT, not what was considered', () => {
  // A budget of one, out of fourteen vendors' work, reaches exactly one vendor,
  // and the line must say one — counting the candidates instead would report
  // fourteen and hide precisely the failure this number exists to show.
  const plan = planEmbeddings(groupedByVendor(), new Map(), MODEL, 1);
  assert.equal(plan.toEmbed.length, 1);
  assert.equal(plan.providers, 1);
  assert.match(describePlan(plan), /across 1 vendor,/);
});

test('an empty plan reports no vendors rather than crashing', () => {
  const plan = planEmbeddings([], new Map(), MODEL, BUDGET);
  assert.equal(plan.providers, 0);
});
