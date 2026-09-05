import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toJobRow, toFeedJob, type JobRow } from '../src/corpus/db-feed.js';
import type { FeedJob } from '../src/corpus/types.js';

/**
 * A field missing from the write mapping is invisible everywhere else.
 *
 * One crawl stored 11,491 unsorted rows and zero adjacent ones because
 * `adjacent` was absent from the object literal writeFeed builds. It was
 * computed correctly, carried through the whole pipeline, logged as classified —
 * and then never written, so every row silently took the column default. No
 * error, no warning, and the classifier looked broken when the classifier was
 * fine.
 *
 * These tests exist so a dropped field fails here instead of after a crawl.
 */

function feedJob(over: Partial<FeedJob> = {}): FeedJob {
  return {
    key: 'greenhouse:acme:1',
    title: 'Backend Engineer',
    company: 'Acme',
    provider: 'greenhouse',
    location: 'Berlin',
    country: 'DE',
    remoteType: 'hybrid',
    seniority: 'senior',
    employmentType: 'fulltime',
    department: 'Engineering',
    salaryMin: 100_000,
    salaryMax: 140_000,
    salaryCurrency: 'EUR',
    postedAt: '2026-09-01T00:00:00.000Z',
    ageDays: 4,
    applyUrl: 'https://example.test/apply',
    saturation: 0,
    components: { ghostRisk: 0.2 },
    reasons: [],
    inScope: true,
    family: 'software',
    specialization: 'backend',
    ai: false,
    matchedSkills: ['Python', 'AWS'],
    skillScore: 12,
    ...over,
  } as FeedJob;
}

test('every column the read path expects is produced by the write path', () => {
  // The check that would have caught the adjacent bug. Both directions are
  // hand-written literals, so nothing but this keeps them in step.
  const row = toJobRow(feedJob()) as Record<string, unknown>;
  const readColumns: (keyof JobRow)[] = [
    'key', 'provider', 'board_token', 'company', 'title', 'location', 'country',
    'remote_type', 'seniority', 'employment_type', 'department', 'salary_min',
    'salary_max', 'salary_currency', 'posted_at', 'apply_url', 'family',
    'adjacent', 'specialization', 'specialization_reason',
    'classification_version', 'ai', 'matched_skills', 'skill_score', 'ghost_risk',
  ];
  const missing = readColumns.filter((c) => !(c in row));
  assert.deepEqual(missing, [], `write mapping is missing: ${missing.join(', ')}`);
});

test('adjacent is written, true and false alike', () => {
  assert.equal((toJobRow(feedJob({ adjacent: true })) as Record<string, unknown>).adjacent, true);
  assert.equal((toJobRow(feedJob({ adjacent: false })) as Record<string, unknown>).adjacent, false);
  // Absent must write false, not undefined: undefined is dropped from the JSON
  // body entirely, which is how the column silently kept its default.
  assert.equal((toJobRow(feedJob()) as Record<string, unknown>).adjacent, false);
});

test('no field is silently undefined', () => {
  // undefined disappears from a JSON payload; null is sent and stored. A column
  // that should be cleared but is undefined keeps whatever it had before.
  const row = toJobRow(feedJob({ specialization: null })) as Record<string, unknown>;
  for (const [k, v] of Object.entries(row)) {
    assert.notEqual(v, undefined, `${k} is undefined and would never reach the database`);
  }
});

test('a row survives the round trip unchanged', () => {
  const original = feedJob({ adjacent: true, family: 'unsorted', specialization: null });
  const back = toFeedJob(toJobRow(original) as unknown as JobRow);
  for (const field of [
    'key', 'title', 'company', 'provider', 'location', 'country', 'remoteType',
    'seniority', 'employmentType', 'department', 'salaryMin', 'salaryMax',
    'salaryCurrency', 'postedAt', 'applyUrl', 'family', 'adjacent',
    'specialization', 'ai', 'matchedSkills', 'skillScore',
  ] as const) {
    assert.deepEqual(back[field], original[field], `${field} did not survive`);
  }
});

test('the board token is recovered from the key', () => {
  // provider:token:externalId. Getting this wrong breaks close-detection, which
  // is scoped by provider+token.
  const row = toJobRow(feedJob({ key: 'workday:kbr:R2026-1' })) as Record<string, unknown>;
  assert.equal(row.board_token, 'kbr');
});

test('ghost risk defaults to 0 rather than undefined', () => {
  const row = toJobRow(feedJob({ components: {} })) as Record<string, unknown>;
  assert.equal(row.ghost_risk, 0);
});
