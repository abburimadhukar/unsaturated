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
  readFrom,
  writeTo,
  QUIET_DEFAULTS,
  INST_DEFAULTS,
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

// ---------------------------------------------------------------------------
// Quiet Roles and Institutions keep their choices in the address bar
// ---------------------------------------------------------------------------

/**
 * Both pages forgot everything on refresh until 20 September 2026: filters back
 * to default, "show 50 more" back to one page, and no way to link anyone to a
 * view. The feed had solved it; these two had neither half.
 *
 * The pair has to agree. A value that serialises one way and parses back
 * another is a filter that silently turns itself off, which is worse than not
 * having it — so these tests are all round trips.
 */

test('a quiet-roles view survives the round trip through a URL', () => {
  const chosen = {
    ...QUIET_DEFAULTS,
    family: 'data',
    q: 'analyst',
    country: 'GB',
    seniority: 'senior',
    midMarket: true,
    paidOnly: true,
    sort: 'quietest',
  };
  assert.deepEqual(readFrom(QUIET_DEFAULTS, `?${writeTo(QUIET_DEFAULTS, chosen)}`), chosen);
});

test('an institutions view survives the round trip through a URL', () => {
  const chosen = {
    ...INST_DEFAULTS,
    sector: 'health',
    family: 'cloud',
    q: 'kubernetes',
    country: 'US',
    specialization: 'devops_sre',
    quietOnly: true,
  };
  assert.deepEqual(readFrom(INST_DEFAULTS, `?${writeTo(INST_DEFAULTS, chosen)}`), chosen);
});

test('a plain visit leaves the address bar clean', () => {
  // Nothing is written for a value that is already the default, so arriving at
  // /quiet does not rewrite the URL into a wall of parameters.
  assert.equal(writeTo(QUIET_DEFAULTS, QUIET_DEFAULTS), '');
  assert.equal(writeTo(INST_DEFAULTS, INST_DEFAULTS), '');
});

test('a link missing newer parameters still opens', () => {
  // An old bookmark carries only what existed when it was made. Anything
  // absent keeps its default rather than arriving as undefined.
  assert.deepEqual(readFrom(QUIET_DEFAULTS, '?family=software'), {
    ...QUIET_DEFAULTS,
    family: 'software',
  });
});

test('a checkbox that is on by default can be turned off by a link', () => {
  // THE trap in this pattern, which is why the pair is shared rather than
  // rewritten per page. Serialising only what differs from the default means a
  // true-by-default switch has to be written as `=0` and read back as false —
  // not dropped as falsy and silently restored to true on the next visit.
  const off = { ...FILTER_DEFAULTS, hideGhosts: false };
  const qs = writeTo(FILTER_DEFAULTS, off);
  assert.match(qs, /hideGhosts=0/);
  assert.equal(readFrom(FILTER_DEFAULTS, `?${qs}`).hideGhosts, false);
});

test('roles we could not place are their own choice, never folded into a country', () => {
  // The main feed made this mistake and corrected it: picking "United States"
  // returned 3,204 postings whose country could not be read, so the count
  // beside the option was wrong and the label was a lie. Both new pages use
  // the sentinel rather than an "include unknown" switch, so a dropdown
  // reading "United Kingdom (206)" returns 206.
  assert.ok(!('includeUnknown' in QUIET_DEFAULTS));
  assert.ok(!('includeUnknown' in INST_DEFAULTS));
  for (const defaults of [QUIET_DEFAULTS, INST_DEFAULTS]) {
    const picked = { ...defaults, country: '__unknown__' };
    assert.equal(readFrom(defaults, `?${writeTo(defaults, picked)}`).country, '__unknown__');
  }
});

test('the feed still serialises exactly as it did', () => {
  // parseFilters and serializeFilters were rewritten on top of the shared pair.
  // The feed's behaviour must not have moved a millimetre.
  const f = { ...FILTER_DEFAULTS, family: 'cloud', country: 'GB', hideGhosts: false };
  assert.deepEqual(parseFilters(`?${serializeFilters(f)}`), f);
  assert.equal(serializeFilters(FILTER_DEFAULTS), '');
});
