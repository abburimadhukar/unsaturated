import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inferUsState, inferCountry } from '../src/ats/geo.js';

/**
 * inferUsState drives the `region` column the Washington page filters on, so its
 * traps are the Washington page's traps. The hard cases are all about the word
 * "Washington" meaning four different things — the state, the district, a town
 * in Pennsylvania, a county in Oregon — and about a state only existing once the
 * country is the United States. These lock those down.
 */

test('a state abbreviation after the city is the state', () => {
  assert.equal(inferUsState('Seattle, WA'), 'WA');
  assert.equal(inferUsState('Bellevue, WA, United States'), 'WA');
  assert.equal(inferUsState('Austin, TX'), 'TX');
  assert.equal(inferUsState('Austin, TX 78701'), 'TX');
  assert.equal(inferUsState('New York, NY'), 'NY');
  // No comma — the abbreviation is the last token of the segment.
  assert.equal(inferUsState('San Francisco CA'), 'CA');
});

test('the full state name resolves when no abbreviation is given', () => {
  assert.equal(inferUsState('Seattle, Washington'), 'WA');
  assert.equal(inferUsState('Spokane, Washington, USA'), 'WA');
});

test('an unambiguous city stands in for its state', () => {
  assert.equal(inferUsState('Seattle'), 'WA');
  assert.equal(inferUsState('Redmond'), 'WA');
  assert.equal(inferUsState('Tacoma'), 'WA');
  assert.equal(inferUsState('San Francisco'), 'CA');
});

test('Washington, D.C. is the district, never the state', () => {
  assert.equal(inferUsState('Washington, DC'), 'DC');
  assert.equal(inferUsState('Washington, D.C.'), 'DC');
  assert.equal(inferUsState('Washington D.C.'), 'DC');
  assert.equal(inferUsState('District of Columbia'), 'DC');
});

test('a town or county that merely shares the name is not the state of Washington', () => {
  // A real town in Pennsylvania and a real county in Oregon. The explicit state
  // code/name wins over the bare word "Washington".
  assert.equal(inferUsState('Washington, PA'), 'PA');
  assert.equal(inferUsState('Washington County, OR'), 'OR');
});

test('Vancouver is Washington only when it says so', () => {
  // Vancouver, WA is a real US city across the river from Portland; a bare
  // Vancouver is British Columbia and must not be filed as a US state at all.
  assert.equal(inferUsState('Vancouver, WA'), 'WA');
  assert.equal(inferUsState('Vancouver, Washington'), 'WA');
  assert.equal(inferUsState('Vancouver'), undefined);
  assert.equal(inferUsState('Vancouver, BC'), undefined);
});

test('a state is only ever inferred for the United States', () => {
  // These inherit inferCountry's traps: a state name or abbreviation inside a
  // non-US string must never leak a region.
  assert.equal(inferCountry('Washington, United Kingdom'), 'GB');
  assert.equal(inferUsState('Washington, United Kingdom'), undefined);
  assert.equal(inferUsState('London, UK'), undefined);
  assert.equal(inferUsState('Pune, IN'), undefined);
  assert.equal(inferUsState('Bengaluru, Karnataka'), undefined);
});

test('"WA" is not read out of the middle of a word', () => {
  // Warsaw contains "wa"; the Indiana town disambiguates to IN, and the Polish
  // capital is not the United States at all.
  assert.equal(inferUsState('Warsaw, IN'), 'IN');
  assert.equal(inferUsState('Warsaw, Poland'), undefined);
});

test('a US location with no recoverable state is left null, not guessed', () => {
  assert.equal(inferUsState('Remote, US'), undefined);
  assert.equal(inferUsState('United States'), undefined);
  assert.equal(inferUsState(''), undefined);
  assert.equal(inferUsState(undefined), undefined);
});

test('an explicit country lets the backfill read the state from a cleaned location', () => {
  // The backfill passes the stored location and the stored country; "US" short-
  // circuits the country check so a bare city still resolves to its state.
  assert.equal(inferUsState('Bellevue', 'US'), 'WA');
  assert.equal(inferUsState('Olympia, WA', 'US'), 'WA');
});
