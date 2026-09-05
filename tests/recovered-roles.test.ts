import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRole } from '../src/taxonomy/families.js';
import { classifyAdjacent, FORCE_ADJACENT } from '../src/taxonomy/adjacent.js';
import type { NormalizedJob } from '../src/ats/types.js';

/**
 * Three exclusion rules were binning engineers for who they talk to rather than
 * what they do. Auditing the bin BY RULE rather than by title is what found
 * them: a rule meant for sales that kills 30% technical titles is broken, and
 * that shows up as a percentage long before anyone spots an individual job.
 *
 *   revenue          binned ~205 on the letters G-T-M
 *   customer-facing  binned ~288 Solutions and Implementation Engineers
 *   devrel/docs      binned  ~21 Developer Advocates
 *
 * All three are now adjacent rather than core. They are technical and they are
 * not building the product, which is exactly what adjacent means — and someone
 * clicking Software must not get 259 Solutions Engineers among the backend
 * roles.
 */

const job = (title: string, body = ''): NormalizedJob =>
  ({ title, descriptionText: body }) as NormalizedJob;

/** What the crawl does: core rules, then adjacent, with the forced exception. */
function place(title: string, body = '') {
  const j = job(title, body);
  const cls = classifyRole(j);
  const adj = cls.family === null || FORCE_ADJACENT.test(title) ? classifyAdjacent(j) : null;
  const family = cls.family ?? adj?.family ?? null;
  if (!family) return cls.excludedReason ? `binned:${cls.excludedReason}` : 'unsorted';
  return `${family}:${adj ? 'adjacent' : 'core'}`;
}

// ---------------------------------------------------------------------------
// Recovered — and adjacent, never core
// ---------------------------------------------------------------------------

for (const [title, expected] of [
  ['GTM Engineer', 'software:adjacent'],
  ['Senior GTM Engineer', 'software:adjacent'],
  ['GTM AI Engineer', 'software:adjacent'],
  ['GTM Systems Administrator', 'cloud:adjacent'],
  ['Staff Software Engineer, Go To Market Systems & AI', 'software:adjacent'],
  ['GTM Staff Data Scientist', 'data:adjacent'],
  ['Solutions Engineer', 'cloud:adjacent'],
  ['Senior Solutions Engineer', 'cloud:adjacent'],
  ['Solution Engineer', 'cloud:adjacent'],
  ['Implementation Engineer', 'cloud:adjacent'],
  ['Customer Success Engineer', 'cloud:adjacent'],
  ['AI Solutions Engineer', 'cloud:adjacent'],
  ['Developer Advocate', 'software:adjacent'],
  ['Developer Relations Engineer', 'software:adjacent'],
  ['Senior Developer Advocate, AI and Machine Learning', 'software:adjacent'],
] as [string, string][]) {
  test(`"${title}" → ${expected}`, () => {
    assert.equal(place(title), expected);
  });
}

// ---------------------------------------------------------------------------
// Still binned, deliberately
// ---------------------------------------------------------------------------

for (const [title, reason] of [
  // Sales operations: pricing approvals and contract terms. "Analyst" in the
  // title does not make it engineering.
  ['Deal Desk Analyst', 'revenue'],
  ['Senior Deal Desk Analyst', 'revenue'],
  // Documentation is a different job from engineering, and shared the rule with
  // Developer Advocate purely by accident of grouping.
  ['Technical Writer', 'devrel/docs'],
  ['Developer Evangelist', 'devrel/docs'],
  // Consultant and manager are account roles, and the title says so. Only the
  // ENGINEER variants were recovered.
  ['Solutions Consultant', 'customer-facing'],
  ['Customer Success Manager', 'customer-facing'],
  ['Implementation Manager', 'customer-facing'],
  ['Sales Engineer', 'sales'],
] as [string, string][]) {
  test(`"${title}" stays binned as ${reason}`, () => {
    assert.equal(place(title), `binned:${reason}`);
  });
}

// ---------------------------------------------------------------------------
// The forced flag: evidence picks the family, the flag survives it
// ---------------------------------------------------------------------------

test('a strong description sets the family but cannot make these core', () => {
  // The whole reason FORCE_ADJACENT exists. A Solutions Engineer listing
  // Kubernetes and Terraform scores well enough to be filed as a core cloud
  // role, and it is not one — it is a pre-sales engineer who knows the stack.
  assert.equal(place('Solutions Engineer', 'kubernetes terraform aws eks helm linux'), 'cloud:adjacent');
  assert.equal(place('Solutions Engineer', 'snowflake dbt airflow spark sql'), 'data:adjacent');
  assert.equal(place('GTM Engineer', 'python django postgres rest api'), 'software:adjacent');
  assert.equal(place('Developer Advocate', 'kubernetes terraform aws'), 'cloud:adjacent');
});

test('ordinary engineers are untouched by the forced rule', () => {
  // FORCE_ADJACENT must not widen to anything else: a real backend role stays
  // core, which is the thing that would break if the pattern were loose.
  assert.equal(place('Backend Engineer', 'python django postgres'), 'software:core');
  assert.equal(place('Site Reliability Engineer', 'kubernetes terraform aws'), 'cloud:core');
  assert.equal(place('Data Engineer', 'snowflake dbt airflow'), 'data:core');
  assert.equal(place('Workday Integration Analyst'), 'hris:core');
});

test('the forced pattern matches whole words only', () => {
  // Without word boundaries "gtm" matches inside unrelated words, and
  // "go.to.market" would match "gooto market" and worse.
  assert.ok(FORCE_ADJACENT.test('GTM Engineer'));
  assert.ok(FORCE_ADJACENT.test('Go To Market Engineer'));
  assert.ok(FORCE_ADJACENT.test('Go-To-Market Analyst'));
  assert.ok(!FORCE_ADJACENT.test('Algorithm Engineer'));
  assert.ok(!FORCE_ADJACENT.test('Budgtmaster'));
  assert.ok(!FORCE_ADJACENT.test('Backend Engineer'));
});

test('the HRIS carve-out in customer-facing still holds', () => {
  // "Workday Implementation Consultant" is the dominant title in that family and
  // must not be binned as a customer-facing role.
  assert.equal(place('Workday Implementation Consultant'), 'hris:core');
  assert.equal(place('HRIS Implementation Consultant'), 'hris:core');
});
