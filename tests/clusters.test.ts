import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRole } from '../src/taxonomy/families.js';
import type { NormalizedJob } from '../src/ats/types.js';

/**
 * Five clusters recovered from the review queue.
 *
 * The queue held 29,174 postings across 19,410 distinct titles — an average of
 * 1.5 postings per title, so reading the top of the list fixes almost nothing
 * and there was never a shortlist to work through. Counting instead found five
 * phrases the rules had simply never learned:
 *
 *   developer, unqualified          1,070   "Quant Library Developer"
 *   architect                         808   "Software Architect"
 *   security engineer                 558   the bare phrase, not "cloud security"
 *   engineering manager / director    449
 *   systems engineer                  513   (already handled as adjacent)
 *
 * Each is a wide net, so most of what follows is about what must NOT come with
 * it: 53 salespeople called Business Developer, 16 guards called Security
 * Officer, 15 building architects, 13 factory engineering managers.
 */

const job = (title: string, body = ''): NormalizedJob =>
  ({ title, descriptionText: body }) as NormalizedJob;
const family = (title: string, body = '') => classifyRole(job(title, body)).family;
const reason = (title: string) => classifyRole(job(title)).excludedReason;

// ---------------------------------------------------------------------------
// Recovered
// ---------------------------------------------------------------------------

for (const [title, expected] of [
  // Developer, in every phrasing the rules previously missed.
  ['Developer', 'software'],
  ['Quant Library Developer, Macro Technology', 'software'],
  ['SmartCOMM Developer', 'software'],
  ['.NET Developer', 'software'],
  ['COBOL IBM Mainframe Developer', 'software'],
  ['Salesforce Developer', 'software'],
  ['ServiceNow Developer', 'software'],
  ['Principal Java Developer', 'software'],
  // Architecture.
  ['Software Architect', 'software'],
  ['Application Architect', 'software'],
  ['Enterprise Architect', 'software'],
  ['AI Architect', 'software'],
  // Information security — the bare phrase almost every employer writes.
  ['Security Engineer', 'cloud'],
  ['Senior Security Engineer', 'cloud'],
  ['Application Security Engineer', 'cloud'],
  ['Product Security Engineer', 'cloud'],
  ['Cyber Security Analyst', 'cloud'],
  ['Information Security Analyst', 'cloud'],
  ['Network Security Engineer', 'cloud'],
  ['Security Architect', 'cloud'],
  ['Penetration Tester', 'cloud'],
  ['IAM Engineer', 'cloud'],
  // Engineering leadership.
  ['Engineering Manager', 'software'],
  ['Director of Engineering', 'software'],
  ['Head of Engineering', 'software'],
  ['VP of Engineering', 'software'],
  ['Engineering Director', 'software'],
] as [string, string][]) {
  test(`"${title}" is ${expected}`, () => {
    assert.equal(family(title), expected);
  });
}

// ---------------------------------------------------------------------------
// What the wide nets must not catch
// ---------------------------------------------------------------------------

test('a Business Developer is a salesperson, not a software engineer', () => {
  // 53 of them. The sales rule said "business development", which does not
  // match "business developer" — one letter, and the widened developer rule
  // would have swallowed every one.
  assert.equal(family('Business Developer'), null);
  assert.equal(reason('Business Developer'), 'sales');
  assert.equal(family('Business Developer / FX Sales Associate'), null);
});

for (const title of [
  // Guarding buildings and people, not networks. 16 postings.
  'Border Security Analyst II',
  'Physical Security Engineer',
  'Site Security Specialist',
  'Corporate Security Analyst',
  'Security Guard',
  'Security Officer',
]) {
  test(`"${title}" is not a cloud role`, () => {
    assert.notEqual(family(title), 'cloud');
  });
}

for (const title of [
  // The word belongs to buildings first. 15 postings.
  'Project Architect',
  'Landscape Architect',
  'Interior Architect',
  'Principal Safety Case Architect',
  'Structural Architect',
]) {
  test(`"${title}" is not a software role`, () => {
    assert.notEqual(family(title), 'software');
  });
}

for (const title of [
  // Identical wording whether the team ships code or runs a production line.
  'Manufacturing Engineering Manager',
  'Regional Market Engineering Manager',
  'Quality Engineering Manager',
  'Plant Engineering Manager',
  'Field Engineering Manager',
  'Director of Civil Engineering',
]) {
  test(`"${title}" is not a software role`, () => {
    assert.notEqual(family(title), 'software');
  });
}

// ---------------------------------------------------------------------------
// Nothing already working may be disturbed
// ---------------------------------------------------------------------------

test('the core titles keep their families', () => {
  assert.equal(family('Backend Engineer', 'python django postgres'), 'software');
  assert.equal(family('Site Reliability Engineer', 'kubernetes terraform aws'), 'cloud');
  assert.equal(family('Data Engineer', 'snowflake dbt airflow'), 'data');
  assert.equal(family('Workday Integration Analyst'), 'hris');
});

test('a cloud-flavoured developer stays in cloud', () => {
  // Cloud is checked before software, and "Cloud Developer" was landing in
  // cloud through the last-resort rule. The widened developer pattern would
  // otherwise have taken it into software — a change with no reason behind it.
  assert.equal(family('Cloud Developer'), 'cloud');
  assert.equal(family('Azure Integration Developer'), 'cloud');
  assert.equal(family('AWS Developer'), 'cloud');
});

test('the industrial and clinical rules are untouched', () => {
  assert.equal(family('Mechanical Engineer'), null);
  assert.equal(family('Registered Nurse'), null);
  assert.equal(family('Delivery Driver'), null);
  assert.equal(family('Mechanical Production Engineer'), null);
});
