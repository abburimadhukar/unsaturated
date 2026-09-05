import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAdjacent } from '../src/taxonomy/adjacent.js';
import { classifyRole } from '../src/taxonomy/families.js';
import type { NormalizedJob } from '../src/ats/types.js';

/**
 * Adjacent widens the net, and the danger of widening a net is what else comes
 * up in it. The discard pile is dominated by other engineering disciplines —
 * 543 mechanical, 524 process, 480 manufacturing, 443 quality, 387 electrical,
 * 929 project engineers at ABB alone — so most of what follows is about what
 * must NOT match.
 */

const job = (title: string, body = ''): NormalizedJob =>
  ({ title, descriptionText: body }) as NormalizedJob;

// "Systems Engineer" is shared by two unrelated professions, so that one rule
// demands evidence the role is an IT one. Titles below that rely on it carry a
// description; see the dedicated tests further down.
const SYS_BODY = 'linux windows server active directory vmware';

// ---------------------------------------------------------------------------
// What it should catch — taken from the live exclusion tally
// ---------------------------------------------------------------------------

const SHOULD_MATCH: [string, string, string?][] = [
  ['Technical Program Manager', 'technical_pm'],
  ['Senior Technical Project Manager', 'technical_pm'],
  ['Lead Technical Product Manager', 'technical_pm'],
  ['IT Systems Engineer', 'systems_engineering'],
  ['Senior Systems Engineer', 'systems_engineering', SYS_BODY],
  ['Business Systems Analyst', 'business_analysis'],
  ['Senior Business Analyst', 'business_analysis'],
  ['Product Analyst', 'business_analysis'],
  ['Marketing Analyst', 'business_analysis'],
  ['Integration Analyst', 'business_analysis'],
  ['Enterprise Architecture Analyst', 'business_analysis'],
  ['Technical Support Engineer', 'technical_support'],
  ['Application Support Developer', 'technical_support'],
  ['Test Engineer', 'test_automation'],
  ['Senior Automation Engineer', 'test_automation'],
  ['Solution Architect', 'solution_architecture'],
  ['Enterprise Architect', 'solution_architecture'],
  ['Staff Engineer', 'generic_engineering'],
  ['Principal Engineer', 'generic_engineering'],
  ['Applications Engineer', 'generic_engineering'],
];

for (const [title, category, body] of SHOULD_MATCH) {
  test(`"${title}" is adjacent (${category})`, () => {
    const m = classifyAdjacent(job(title, body ?? ''));
    assert.ok(m, 'expected a match');
    assert.equal(m.category, category);
    // Always lands in a real family, so every existing filter keeps working.
    assert.ok(['cloud', 'software', 'data', 'hris'].includes(m.family));
  });
}

// ---------------------------------------------------------------------------
// What it must never catch
// ---------------------------------------------------------------------------

const MUST_NOT_MATCH = [
  // Other engineering disciplines — the bulk of the discard pile.
  'Mechanical Engineer',
  'Senior Mechanical Engineer',
  'Electrical Engineer',
  'Process Engineer',
  'Manufacturing Engineer',
  'Quality Engineer',
  'Civil Engineer',
  'Chemical Engineer',
  'Project Engineer',
  'Plant Engineer',
  'Field Service Engineer',
  'Industrial Engineer',
  'Structural Engineer',
  'Aerospace Engineer',
  'HVAC Engineer',
  'Maintenance Technician',
  // Technical-sounding titles that are not technical jobs. "Security Officer"
  // is the single largest title in the discard pile at 1,024 postings, and all
  // of them are guards.
  'Security Officer',
  'Security Guard',
  'Board Certified Behavior Analyst',
  'Data Entry Specialist',
  'Sports Data Collector',
  'Registered Nurse',
  // A trial run matched these: in buildings, hotels and shipping the Chief
  // Engineer runs maintenance.
  'Chief Engineer',
  'Chief Engineer - Hotel Operations',
];

for (const title of MUST_NOT_MATCH) {
  test(`"${title}" is never adjacent`, () => {
    assert.equal(classifyAdjacent(job(title)), null);
  });
}

// ---------------------------------------------------------------------------
// How it relates to the core rules
// ---------------------------------------------------------------------------

test('a plain Product Manager stays excluded', () => {
  // 15,038 postings sit under the management rule and only ~595 carry
  // "technical". Matching the rest would swamp the feed with non-engineering
  // roles and destroy the point of the filter.
  assert.equal(classifyAdjacent(job('Product Manager')), null);
  assert.equal(classifyAdjacent(job('Senior Project Manager')), null);
  assert.equal(classifyAdjacent(job('Office Manager')), null);
  assert.equal(classifyAdjacent(job('Community Manager')), null);
});

test('adjacent never overrides a role the core rules already claimed', () => {
  // The contract that keeps this safe: it only ever runs where family is null.
  for (const title of ['Backend Engineer', 'Site Reliability Engineer', 'Data Engineer', 'Workday Analyst']) {
    assert.notEqual(classifyRole(job(title, 'python aws sql workday')).family, null,
      `${title} should already have a family`);
  }
});

test('the description picks the family when it says anything', () => {
  const cloudy = classifyAdjacent(job('Business Systems Analyst', 'kubernetes terraform aws eks helm'));
  assert.equal(cloudy?.family, 'cloud');
  const datay = classifyAdjacent(job('Business Systems Analyst', 'snowflake dbt airflow spark sql'));
  assert.equal(datay?.family, 'data');
});

test('a silent posting still lands somewhere, and says so', () => {
  // 18% of postings carry no description at all; refusing those would drop the
  // majority of what this is meant to recover.
  const m = classifyAdjacent(job('Technical Program Manager'));
  assert.equal(m?.family, 'software');
  assert.match(m?.reason ?? '', /no description evidence/);
});

test('a matched description records what it scored', () => {
  const m = classifyAdjacent(job('Systems Engineer', 'linux kubernetes aws terraform'));
  assert.match(m?.reason ?? '', /description scored \d+ for cloud/);
});

// ---------------------------------------------------------------------------
// "Systems Engineer" needs evidence, because two professions share the title
// ---------------------------------------------------------------------------

test('a bare Systems Engineer with no evidence is refused', () => {
  // Deliberate. The first live crawl filed "Senior Fuel Systems Engineer, Air
  // Vehicles" and "Senior Battery Systems Engineer" at Anduril, and "Ground
  // Systems Engineer II - Structures & Mechanisms" at Rocket Lab, as adjacent
  // cloud roles. With nothing to go on, refusing is the honest answer — the
  // next crawl fetches a description and can decide properly.
  assert.equal(classifyAdjacent(job('Systems Engineer')), null);
  assert.equal(classifyAdjacent(job('Senior Systems Engineer')), null);
});

test('an IT signal in the title or the body is enough', () => {
  assert.ok(classifyAdjacent(job('IT Systems Engineer')));
  assert.ok(classifyAdjacent(job('Systems Engineer', 'active directory vmware windows server')));
  assert.ok(classifyAdjacent(job('Enterprise Systems Engineer')));
});

test('the IT acronym is matched case-sensitively, not as the English word', () => {
  // A word-boundary "it" in a case-insensitive pattern matches "it" in nearly every
  // description, which would let the whole check pass for everything and
  // silently do nothing.
  assert.equal(classifyAdjacent(job('Systems Engineer', 'it is a great place to work')), null);
});

test('hardware systems engineering never becomes an adjacent cloud role', () => {
  for (const title of [
    'Senior Fuel Systems Engineer, Air Vehicles',
    'Senior Battery Systems Engineer',
    'Ground Systems Engineer II - Structures & Mechanisms',
    'Staff BIOS/Platform System Engineer',
    'Propulsion Systems Engineer',
    'Optical Systems Engineer',
    'RF Systems Engineer',
    'Robotics Systems Engineer',
  ]) {
    assert.equal(classifyAdjacent(job(title, 'linux server network')), null, title);
  }
});
