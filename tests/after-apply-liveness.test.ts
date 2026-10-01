import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jobLiveness, GHOST_RISK_THRESHOLD } from '../src/after-apply/liveness.js';

/**
 * The "is this role live?" read. Every line must come from a real stored field —
 * the crawler's first/last-seen timestamps, the close date, and the ghost_risk
 * the feed already trusts — and when there is no signal it must say so rather
 * than guess. The clock is injected so ages are testable without sleeping.
 */

const NOW = Date.parse('2026-10-01T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test('a recently-seen, low-risk posting reads as live', () => {
  const l = jobLiveness(
    { postedAt: daysAgo(4), firstSeenAt: daysAgo(4), lastSeenAt: daysAgo(0), closedAt: null, ghostRisk: 0.1 },
    NOW,
  );
  assert.equal(l.tone, 'live');
  assert.match(l.headline, /looks live/i);
  assert.ok(l.points.some((p) => /still listed/i.test(p)), 'says still listed');
  assert.ok(l.points.some((p) => /low ghost-job risk \(10%\)/i.test(p)), 'shows the risk %');
  assert.ok(l.points.some((p) => /posted about 4 days ago/i.test(p)), 'shows the age');
});

test('a closed posting is a caution and says it may be closed', () => {
  const l = jobLiveness(
    { postedAt: daysAgo(40), firstSeenAt: daysAgo(40), lastSeenAt: daysAgo(10), closedAt: daysAgo(2), ghostRisk: 0.1 },
    NOW,
  );
  assert.equal(l.tone, 'caution');
  assert.match(l.headline, /may be closed/i);
  assert.ok(l.points.some((p) => /no longer listed/i.test(p)));
});

test('elevated ghost risk is a caution carrying the percentage', () => {
  assert.equal(GHOST_RISK_THRESHOLD, 0.4);
  const l = jobLiveness(
    { postedAt: daysAgo(200), firstSeenAt: daysAgo(200), lastSeenAt: daysAgo(0), closedAt: null, ghostRisk: 0.6 },
    NOW,
  );
  assert.equal(l.tone, 'caution');
  assert.match(l.headline, /worth checking/i);
  assert.ok(l.points.some((p) => /elevated ghost-job risk \(60%\)/i.test(p)));
});

test('no signals at all stays honest rather than guessing', () => {
  const l = jobLiveness(
    { postedAt: null, firstSeenAt: null, lastSeenAt: null, closedAt: null, ghostRisk: null },
    NOW,
  );
  assert.equal(l.tone, 'unknown');
  assert.ok(l.points.some((p) => /fresh crawl signals/i.test(p)));
});

test('first-seen stands in when there is no posted date', () => {
  const l = jobLiveness(
    { postedAt: null, firstSeenAt: daysAgo(3), lastSeenAt: daysAgo(1), closedAt: null, ghostRisk: 0.2 },
    NOW,
  );
  assert.ok(l.points.some((p) => /first seen about 3 days ago/i.test(p)));
});

test('a single day is not pluralised', () => {
  const l = jobLiveness(
    { postedAt: daysAgo(1), firstSeenAt: daysAgo(1), lastSeenAt: daysAgo(0), closedAt: null, ghostRisk: 0.1 },
    NOW,
  );
  assert.ok(l.points.some((p) => /posted about 1 day ago/i.test(p)));
});
