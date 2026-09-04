import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseTitle, tallyExclusions } from '../src/corpus/exclusions.js';
import type { FeedJob } from '../src/corpus/types.js';

/**
 * The tally is the only record that 93% of every crawl was discarded for
 * defensible reasons. If it silently counts nothing — because it was handed an
 * already-filtered list, or because normalisation collapsed every title to the
 * same string — the instrument reads clean while measuring nothing, which is
 * worse than having no instrument.
 */

function job(over: Partial<FeedJob>): FeedJob {
  return {
    key: 'greenhouse:acme:1', title: 'Engineer', company: 'Acme', provider: 'greenhouse',
    location: null, country: null, remoteType: null, seniority: null, employmentType: null,
    department: null, salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    ageDays: null, applyUrl: null, saturation: 0, components: {}, reasons: [],
    inScope: false, family: null, ai: false, matchedSkills: [], skillScore: 0,
    ...over,
  } as FeedJob;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('titles differing only in employer noise collapse to one row', () => {
  const same = [
    'Senior Backend Engineer (Remote)',
    'Senior Backend Engineer [REQ-1029]',
    'Senior Backend Engineer - Chicago, IL',
    '  Senior   Backend   Engineer  ',
    'SENIOR BACKEND ENGINEER',
  ].map(normaliseTitle);
  assert.equal(new Set(same).size, 1, `collapsed to ${JSON.stringify([...new Set(same)])}`);
  assert.equal(same[0], 'senior backend engineer');
});

test('normalisation never removes a word that carries meaning', () => {
  // The whole point is reading the words back, so anything that changes which
  // words are present defeats the table.
  assert.equal(normaliseTitle('Cloud Operations Engineer'), 'cloud operations engineer');
  assert.equal(normaliseTitle('C# / .NET Developer'), 'c# / .net developer');
  assert.equal(normaliseTitle('Data Engineer II'), 'data engineer ii');
  assert.equal(normaliseTitle('Site Reliability Engineer, Platform'), 'site reliability engineer platform');
});

test('distinct roles stay distinct', () => {
  const titles = ['Backend Engineer', 'Frontend Engineer', 'Warehouse Associate', 'Delivery Driver'];
  assert.equal(new Set(titles.map(normaliseTitle)).size, 4);
});

test('a title that normalises to nothing is dropped, not counted as empty', () => {
  assert.equal(normaliseTitle('(remote)'), '');
  assert.equal(normaliseTitle('!!!'), '');
  const rows = tallyExclusions([job({ title: '!!!', excludedReason: 'sales' })]);
  assert.equal(rows.length, 0);
});

test('an absurdly long title is truncated rather than stored whole', () => {
  assert.ok(normaliseTitle('Engineer '.repeat(100)).length <= 120);
});

// ---------------------------------------------------------------------------
// Tallying
// ---------------------------------------------------------------------------

test('counts are grouped by rule AND title, not one or the other', () => {
  const rows = tallyExclusions([
    job({ title: 'Delivery Driver', excludedReason: 'manual' }),
    job({ title: 'Delivery Driver', excludedReason: 'manual' }),
    job({ title: 'Delivery Driver', excludedReason: 'sales' }),
    job({ title: 'Warehouse Associate', excludedReason: 'manual' }),
  ]);
  const find = (reason: string, title: string) =>
    rows.find((r) => r.reason === reason && r.title === title)?.n;
  assert.equal(find('manual', 'delivery driver'), 2);
  // Same title, different rule: a separate row, or you cannot tell which rule
  // is responsible for what.
  assert.equal(find('sales', 'delivery driver'), 1);
  assert.equal(find('manual', 'warehouse associate'), 1);
});

test('in-scope jobs are never counted as discards', () => {
  const rows = tallyExclusions([
    job({ title: 'Backend Engineer', inScope: true, family: 'software' }),
    job({ title: 'Delivery Driver', excludedReason: 'manual' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, 'delivery driver');
});

test('an already-filtered list yields nothing rather than looking healthy', () => {
  // The failure mode this guards: calling the tally AFTER `.filter(j => j.inScope)`
  // would report zero discards from a crawl that discarded 224,000 postings.
  const kept = [job({ title: 'Backend Engineer', inScope: true, family: 'software' })];
  assert.deepEqual(tallyExclusions(kept), []);
});

test('a job no rule excluded and no family claimed gets its own reason', () => {
  // The interesting case. Previously indistinguishable from a deliberate
  // exclusion, because both left nothing behind.
  const rows = tallyExclusions([job({ title: 'Forward Deployed Engineer' })]);
  assert.equal(rows[0]?.reason, 'no family matched');
  assert.equal(rows[0]?.n, 1);
});

test('results are ordered by count, because only the top of the list gets read', () => {
  const rows = tallyExclusions([
    ...Array.from({ length: 3 }, () => job({ title: 'Rare Role', excludedReason: 'sales' })),
    ...Array.from({ length: 40 }, () => job({ title: 'Common Role', excludedReason: 'manual' })),
    ...Array.from({ length: 12 }, () => job({ title: 'Middling Role', excludedReason: 'legal' })),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [40, 12, 3]);
});

test('the write is capped, and the cap keeps the largest counts', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    Array.from({ length: i + 1 }, () => job({ title: `Role ${i}`, excludedReason: 'sales' })),
  ).flat();
  const rows = tallyExclusions(many, 5);
  assert.equal(rows.length, 5);
  // Largest kept, not an arbitrary five: a cap that dropped the common titles
  // would hide exactly what the table exists to show.
  assert.deepEqual(rows.map((r) => r.n), [50, 49, 48, 47, 46]);
});

test('a sample company is carried so a title can be traced back', () => {
  const rows = tallyExclusions([job({ title: 'Cloud Operations Engineer', company: 'Globex' })]);
  assert.equal(rows[0]?.sampleCompany, 'Globex');
});

test('an empty crawl tallies nothing without throwing', () => {
  assert.deepEqual(tallyExclusions([]), []);
});
