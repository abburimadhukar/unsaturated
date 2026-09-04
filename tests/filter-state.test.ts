import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILTER_DEFAULTS,
  applyFilterChange,
  parseFilters,
  sanitizeFilters,
  serializeFilters,
  specializationAllowed,
  specializationsFor,
  toggleFilter,
} from '../src/ui/filter-state.js';
import { SPECIALIZATIONS_BY_FAMILY, UNKNOWN_SPECIALIZATION } from '../src/taxonomy/specializations.js';

// ---------------------------------------------------------------------------
// Which options a family offers
// ---------------------------------------------------------------------------

test('a family offers only its own specializations', () => {
  assert.deepEqual(specializationsFor('software'), SPECIALIZATIONS_BY_FAMILY.software);
  assert.deepEqual(specializationsFor('hris'), SPECIALIZATIONS_BY_FAMILY.hris);
  assert.ok(!(specializationsFor('data') as readonly string[]).includes('frontend'));
});

test('no family means no list at all, rather than every family mixed together', () => {
  assert.deepEqual(specializationsFor(''), []);
  assert.deepEqual(specializationsFor('nonsense'), []);
});

test('"all" and "unknown" are valid under any family', () => {
  for (const family of ['software', 'cloud', 'data', 'hris']) {
    assert.equal(specializationAllowed(family, ''), true);
    assert.equal(specializationAllowed(family, UNKNOWN_SPECIALIZATION), true);
  }
});

// ---------------------------------------------------------------------------
// Changing family clears an incompatible specialization
// ---------------------------------------------------------------------------

test('changing family clears a specialization that belonged to the old one', () => {
  const before = { ...FILTER_DEFAULTS, family: 'software', specialization: 'frontend' };
  const after = applyFilterChange(before, 'family', 'data');
  assert.equal(after.family, 'data');
  assert.equal(after.specialization, '');
});

test('changing family keeps a specialization the new family also has', () => {
  // There is no such pair today — every value belongs to exactly one family —
  // so this asserts the mechanism rather than the data: '' and '__unknown__'
  // survive any change, which is what stops the filter resetting itself for no
  // reason every time someone switches tab.
  const before = { ...FILTER_DEFAULTS, family: 'software', specialization: UNKNOWN_SPECIALIZATION };
  const after = applyFilterChange(before, 'family', 'cloud');
  assert.equal(after.specialization, UNKNOWN_SPECIALIZATION);
});

test('clearing the family clears an incompatible specialization with it', () => {
  const before = { ...FILTER_DEFAULTS, family: 'cloud', specialization: 'devops_sre' };
  const after = toggleFilter(before, 'family', 'cloud'); // clicking the selected tab
  assert.equal(after.family, '');
  assert.equal(after.specialization, '');
});

test('changing an unrelated filter leaves the specialization alone', () => {
  const before = { ...FILTER_DEFAULTS, family: 'data', specialization: 'analytics_bi' };
  const after = applyFilterChange(before, 'country', 'IN');
  assert.equal(after.specialization, 'analytics_bi');
  assert.equal(after.country, 'IN');
});

test('sanitize is a no-op on a pair that is already consistent', () => {
  const filters = { ...FILTER_DEFAULTS, family: 'hris', specialization: 'workday' };
  assert.equal(sanitizeFilters(filters), filters);
});

// ---------------------------------------------------------------------------
// The URL carries both, and survives a refresh
// ---------------------------------------------------------------------------

test('family and specialization round-trip through the URL', () => {
  const chosen = { ...FILTER_DEFAULTS, family: 'software', specialization: 'backend' };
  const qs = serializeFilters(chosen);
  assert.match(qs, /family=software/);
  assert.match(qs, /specialization=backend/);

  const restored = parseFilters(`?${qs}`);
  assert.equal(restored.family, 'software');
  assert.equal(restored.specialization, 'backend');
});

test('"Unknown specialization" round-trips as its own value', () => {
  const chosen = { ...FILTER_DEFAULTS, family: 'data', specialization: UNKNOWN_SPECIALIZATION };
  const restored = parseFilters(`?${serializeFilters(chosen)}`);
  assert.equal(restored.family, 'data');
  assert.equal(restored.specialization, UNKNOWN_SPECIALIZATION);
});

test('a shared link pairing a specialization with the wrong family opens on the family', () => {
  // Someone hand-edits a URL, or a link is shared after the taxonomy changed.
  // Dropping the specialization shows the family's jobs; keeping it would show
  // an empty list that reads as "there are no cloud jobs".
  const restored = parseFilters('?family=cloud&specialization=frontend');
  assert.equal(restored.family, 'cloud');
  assert.equal(restored.specialization, '');
});

test('an unrecognised specialization is dropped rather than sent to the API', () => {
  const restored = parseFilters('?family=software&specialization=not_a_real_thing');
  assert.equal(restored.specialization, '');
});

test('a link written before specialization existed still opens', () => {
  const restored = parseFilters('?family=data&country=IN&sort=salary');
  assert.equal(restored.family, 'data');
  assert.equal(restored.specialization, '');
  assert.equal(restored.country, 'IN');
  assert.equal(restored.sort, 'salary');
});

test('defaults are omitted from the URL, so a plain visit has a clean one', () => {
  assert.equal(serializeFilters({ ...FILTER_DEFAULTS }), '');
});

test('every filter survives a full round trip', () => {
  const chosen = {
    ...FILTER_DEFAULTS,
    q: 'kubernetes',
    family: 'cloud',
    specialization: 'devops_sre',
    country: 'IN',
    remote: 'fully_remote',
    seniority: 'senior',
    postedWithinDays: '7',
    ai: true,
    includeUnknown: false,
    employmentType: 'contract',
    stack: 'python',
    hideGhosts: false,
    sort: 'salary',
  };
  assert.deepEqual(parseFilters(`?${serializeFilters(chosen)}`), chosen);
});
