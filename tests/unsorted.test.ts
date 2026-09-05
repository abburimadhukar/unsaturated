import { test } from 'node:test';
import assert from 'node:assert/strict';

import { belongsInReviewPile } from '../src/taxonomy/unsorted.js';
import { classifySpecialization } from '../src/taxonomy/specializations.js';
import { specializationsFor, parseFilters } from '../src/ui/filter-state.js';
import { FAMILY_ORDER, FAMILY_LABELS } from '../src/taxonomy/families.js';
import type { NormalizedJob } from '../src/ats/types.js';

/**
 * The review queue is only useful if it is worth opening. The raw pile is
 * 374,272 postings across 35,512 titles and is overwhelmingly chefs, nurses and
 * machinists; a gate that lets those through produces a second corpus rather
 * than a queue, and nobody will look at it twice.
 *
 * So most of this is about what must stay OUT.
 */

const job = (title: string, body = ''): NormalizedJob =>
  ({ title, descriptionText: body }) as NormalizedJob;

// ---------------------------------------------------------------------------
// Worth a look
// ---------------------------------------------------------------------------

for (const title of [
  'Azure Integration Engineering Manager',
  'Digital Forensics Senior Consultant',
  'IT Support Analyst',
  'Microsoft Dynamics 365 ERP Technical Consultant',
  'Senior Power Platform Functional Consultant',
  'Cyber Security Assessment Manager',
  'Salesforce Functional Lead',
  'Sr Bus Intelligence Analyst I',
]) {
  test(`"${title}" goes in the review pile`, () => {
    assert.equal(belongsInReviewPile(job(title)), true);
  });
}

test('a title with no technical word still qualifies on description evidence', () => {
  // 18% of postings have no description, but where there is one, a body naming
  // real tools is worth a glance whatever the title calls itself.
  assert.equal(belongsInReviewPile(job('Operations Specialist')), false);
  assert.equal(
    belongsInReviewPile(job('Operations Specialist', 'kubernetes terraform aws snowflake')),
    true,
  );
});

// ---------------------------------------------------------------------------
// Must stay out — this is the part that decides whether the queue is usable
// ---------------------------------------------------------------------------

for (const title of [
  // Physical security: the single largest false-positive source in the trial.
  'Security Officer',
  'Security Officers Wanted - South Eastern Suburbs',
  'Event Security Officers - MotoGP Phillip Island 2026',
  'Security Supervisor',
  'Security Site Lead',
  'Security Operations Center Supervisor',
  'Just Got Your NSW Security License? Apply today!',
  // Other engineering disciplines.
  'Mechanical Engineer',
  'Highway Design Engineer / Project Manager',
  'Highway Engineer',
  'Process Engineer',
  'Manufacturing Engineer',
  'Field Service Engineer',
  'Maintenance Technician',
  // Not our world at all.
  'Registered Nurse',
  'Clinical Research Associate',
  'Head Chef',
  'Delivery Driver',
  'Warehouse Associate',
  'Retail Associate',
]) {
  test(`"${title}" never reaches the review pile`, () => {
    assert.equal(belongsInReviewPile(job(title)), false);
  });
}

test('the plural of "security officer" is blocked, not just the singular', () => {
  // The first blocklist said `security officer` with a trailing word boundary,
  // which the s in "Officers" is not — so every bulk guard posting sailed past.
  assert.equal(belongsInReviewPile(job('Security Officers')), false);
  assert.equal(belongsInReviewPile(job('Security Guards')), false);
});

// ---------------------------------------------------------------------------
// It is a queue, not a category
// ---------------------------------------------------------------------------

test('unsorted is a family the UI knows about, listed last', () => {
  assert.ok(FAMILY_ORDER.includes('unsorted'));
  assert.equal(FAMILY_ORDER[FAMILY_ORDER.length - 1], 'unsorted');
  assert.equal(FAMILY_LABELS.unsorted, 'Unsorted');
});

test('unsorted offers no specializations, so its dropdown stays hidden', () => {
  assert.deepEqual(specializationsFor('unsorted'), []);
  for (const f of ['cloud', 'software', 'data', 'hris']) {
    assert.ok(specializationsFor(f).length > 0, `${f} should have some`);
  }
});

test('classifying a specialization under unsorted returns null, not a guess', () => {
  const r = classifySpecialization('unsorted', 'Azure Integration Engineering Manager');
  assert.equal(r.specialization, null);
  assert.match(r.reason, /awaiting review/);
});

test('a URL asking for unsorted survives a round trip', () => {
  const f = parseFilters('?family=unsorted');
  assert.equal(f.family, 'unsorted');
  // No specialization can be carried with it, whatever the link says.
  assert.equal(parseFilters('?family=unsorted&specialization=backend').specialization, '');
});
