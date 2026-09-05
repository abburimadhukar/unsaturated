import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRole } from '../src/taxonomy/families.js';
import { classifyAdjacent } from '../src/taxonomy/adjacent.js';
import type { NormalizedJob } from '../src/ats/types.js';

/**
 * HRIS was the smallest family by a distance — 389 roles against Software's
 * 6,806 — and 507 HR-flavoured postings were sitting unclassified. The cause was
 * a single over-specific rule: the vendor product had to be followed IMMEDIATELY
 * by one of six nouns, so "Workday Techno Functional Consultant", "Workday
 * Extend Consultant" and "SuccessFactors Support Analyst" matched nothing at all.
 *
 * These tests hold the new line: a vendor name anywhere in the title is enough,
 * payroll needs a systems word to be core, and the management half goes adjacent
 * rather than diluting a family called HR Information Systems.
 */

const job = (title: string, body = ''): NormalizedJob =>
  ({ title, descriptionText: body }) as NormalizedJob;

const family = (title: string) => classifyRole(job(title)).family;

// ---------------------------------------------------------------------------
// Tier 1 — a vendor product anywhere in the title
// ---------------------------------------------------------------------------

for (const title of [
  'Workday Analyst',
  'Workday Functional Analyst',
  'Workday Integration Analyst',
  'Workday Configuration Analyst',
  'Workday Implementation Consultant',
  // Every one of these was invisible before: no rule excluded them, no rule
  // reached them.
  'Workday Techno Functional Consultant',
  'Workday Application Consultant',
  'Workday Extend Consultant',
  'Workday Platform Manager',
  'Workday User Experience Analyst III',
  'Manager, Workday Compensation & Talent',
  'VP, Enterprise Systems, Workday',
  'SuccessFactors Support Analyst',
  'Manager, SAP SuccessFactors Platform',
  'PeopleSoft Developer',
  'UKG Analyst',
  'Kronos Systems Administrator',
  'Dayforce Consultant',
  'HRIS Analyst',
  'HCM Solution Lead',
]) {
  test(`"${title}" is HRIS`, () => {
    assert.equal(family(title), 'hris');
  });
}

// ---------------------------------------------------------------------------
// Tier 2 — payroll and benefits WITH a systems word
// ---------------------------------------------------------------------------

for (const title of [
  'Payroll Analyst',
  'Payroll Systems Analyst',
  'Payroll Administrator',
  'Payroll Specialist',
  'Senior Payroll Specialist',
  'Benefits Administrator',
  'Benefits Systems Analyst',
  'Total Rewards Specialist',
  'Compensation Analyst',
  'Analyst, Global Payroll',
  'People Analytics Analyst',
  'HR Reporting Analyst',
]) {
  test(`"${title}" is core HRIS (systems side)`, () => {
    assert.equal(family(title), 'hris');
  });
}

test('the two halves of a payroll title match in either order', () => {
  // Two lookaheads rather than an enumeration, so word order does not matter.
  assert.equal(family('Payroll Systems Analyst'), 'hris');
  assert.equal(family('Systems Analyst, Payroll'), 'hris');
});

// ---------------------------------------------------------------------------
// Tier 3 — payroll and benefits MANAGEMENT goes adjacent, not core
// ---------------------------------------------------------------------------

for (const title of [
  'Payroll Manager',
  'Senior Payroll Manager',
  'Manager, Payroll',
  'Director Global Benefits',
  'Benefits Manager',
  'Manager Compensation',
  'Global Benefits Lead',
  'Junior Payroll Officer',
  'Senior Compensation Partner',
]) {
  test(`"${title}" is HRIS-adjacent, not core`, () => {
    // 80 of the 94 such titles in the corpus are Manager, Director, Head, Lead,
    // VP or Partner: they run the function and its vendors, not the system.
    assert.equal(family(title), null, 'should not be core HRIS');
    const a = classifyAdjacent(job(title));
    assert.ok(a, 'should be adjacent');
    assert.equal(a.family, 'hris');
    assert.equal(a.category, 'hris_operations');
  });
}

// ---------------------------------------------------------------------------
// Workday outside HR
// ---------------------------------------------------------------------------

for (const title of [
  'Principal Workday Financials Consultant (FDM/R2R)',
  'Workday Supply Chain-Healthcare',
  'Workday Apps Mgr Finance & Supply',
  'Senior Consultant - Functional Specialist (Workday Financials)',
  // Adaptive Planning is Workday's financial planning module, not an HR one.
  'Workday Adaptive Planning Administrator',
]) {
  test(`"${title}" is HRIS-adjacent, not core`, () => {
    // The same platform doing finance or procurement. Close enough to matter to
    // someone with Workday experience, wrong enough that an HR filter should
    // not return it unasked.
    assert.equal(family(title), null);
    const a = classifyAdjacent(job(title));
    assert.equal(a?.family, 'hris');
    assert.equal(a?.category, 'hris_platform');
  });
}

// ---------------------------------------------------------------------------
// What must still stay out
// ---------------------------------------------------------------------------

test('engineers who merely work AT an HR vendor are not HRIS', () => {
  // Without this, every backend engineer at Workday or Gusto is misfiled.
  assert.notEqual(family('Senior Software Engineer, Workday'), 'hris');
  assert.notEqual(family('Frontend Engineer at UKG'), 'hris');
  assert.notEqual(family('Data Engineer, Workday Platform'), 'hris');
});

test('ordinary English words are not treated as vendors', () => {
  // 'namely', 'gusto' and 'rippling' were deliberately left out of the product
  // list: matching them would file a backend engineer at Rippling as HRIS.
  assert.notEqual(family('Namely the best job you will find'), 'hris');
  assert.notEqual(family('Backend Engineer'), 'hris');
});

test('generic HR is neither core nor adjacent HRIS', () => {
  // Tier 4, deliberately excluded: an HR Business Partner under a filter called
  // HRIS would make the label a lie.
  for (const title of [
    'HR Business Partner', 'HR Generalist', 'HR Coordinator', 'Recruiter',
    // People Operations is the same thing under a newer name. It was briefly
    // pulled in by the payroll rule and dragged 130 generic HR roles with it.
    'People Operations Generalist', 'People Operations Partner',
    'Senior People Operations Manager',
  ]) {
    assert.equal(family(title), null, `${title} should not be core`);
    const a = classifyAdjacent(job(title));
    assert.notEqual(a?.category, 'hris_operations', `${title} should not be adjacent HRIS`);
  }
});

test('payroll without a systems word never reaches core', () => {
  // The whole point of the tier split: "Payroll Specialist" configures the
  // system, "Payroll Manager" manages the function.
  assert.equal(family('Payroll Specialist'), 'hris');
  assert.equal(family('Payroll Manager'), null);
});
