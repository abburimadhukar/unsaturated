import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GROWTH,
  claimTokens,
  containsClaim,
  growthCeiling,
  normalise,
  verifyEdit,
  verifyEdits,
  type Edit,
} from '../src/tailor/edits.js';

/**
 * The promise this feature makes, and the code that keeps it.
 *
 * A tailored resume is worthless if it says something its owner cannot defend in
 * an interview. Every product in this space asks the model not to invent and
 * hopes; TailoredCV's top tier advertises "potentially adding new relevant skills
 * or experiences", which is fabrication as a feature.
 *
 * Here the rule is enforced by arithmetic rather than by instruction, so these
 * tests are the feature. The resume below stands in for the real one on the site
 * — 9,522 characters, 23 skills — and the skills are that person's actual list,
 * so a test passing here means it passes against real data.
 */

const RESUME = [
  'Madhukar Abburi — Platform and Data Engineer',
  '',
  'EXPERIENCE',
  'Senior Platform Engineer, Acme Corp, 2021 to present',
  'Managed cloud infrastructure for the platform team across AWS and Azure.',
  'Built CI/CD pipelines with Docker and Kubernetes, cutting deploy time to 12 minutes.',
  'Owned the Terraform estate and the Linux fleet.',
  'Data Engineer, Beta Ltd, 2019 to 2021',
  'Wrote Python and SQL for the warehouse, and dbt models on top of it.',
  'Ran Streaming ingestion and Orchestration for 40 daily pipelines.',
  '',
  'SKILLS',
  'AWS, Azure, Kubernetes, Terraform, Docker, CI/CD, Linux, Scripting, Python, Java,',
  'Databases, LLM Tooling, SQL, Big Data, Orchestration, dbt, Warehouse, BI Tools,',
  'Streaming, Pipelines, Python Data, ML Frameworks, Modeling',
].join('\n');

const edit = (original: string, replacement: string, reason = 'because'): Edit => ({
  original,
  replacement,
  reason,
});

// ---------------------------------------------------------------------------
// The lie this exists to stop
// ---------------------------------------------------------------------------

test('A FABRICATED METRIC IS NEVER SILENTLY ACCEPTED', () => {
  // The exact failure. The posting wants "reduced infrastructure spend", so the
  // model supplies a number — specific, plausible, checkable by an interviewer,
  // and never stated by the person. It reads better than the original, which is
  // what makes it dangerous.
  const c = verifyEdit(
    edit(
      'Managed cloud infrastructure for the platform team across AWS and Azure.',
      'Cut cloud infrastructure spend 40% for the platform team across AWS and Azure.',
    ),
    RESUME,
  );

  assert.notEqual(c.verdict, 'accepted', 'a number the resume never gave was waved through');
  assert.ok(c.unverified.includes('40%'), `expected 40% to be named, got ${c.unverified.join(',')}`);
  assert.match(c.note, /40%/, 'the warning must name the number, not just say "unverified"');
});

test('A TOOL THE RESUME DOES NOT CLAIM IS NEVER SILENTLY ACCEPTED', () => {
  // The other half, and the one a job posting actively invites: the advert asks
  // for Kafka, so the model adds Kafka. The resume says Streaming and never says
  // Kafka, and those are not the same claim.
  const c = verifyEdit(
    edit(
      'Ran Streaming ingestion and Orchestration for 40 daily pipelines.',
      'Ran Kafka ingestion and Airflow orchestration for 40 daily pipelines.',
    ),
    RESUME,
  );

  assert.notEqual(c.verdict, 'accepted');
  assert.ok(c.unverified.includes('kafka'), `Kafka was not caught: ${c.unverified.join(',')}`);
  assert.ok(c.unverified.includes('airflow'), `Airflow was not caught: ${c.unverified.join(',')}`);
});

test('THE POSTING IS NOT A SOURCE OF FACTS, ONLY OF WORDS', () => {
  // verifyEdit takes no job description ON PURPOSE, and this test is that
  // decision written down. Allowing a term because the POSTING mentions it is
  // precisely how "they want Terraform" becomes "I have used Terraform" — and a
  // signature that accepted the JD would make that hole easy to open later.
  assert.equal(verifyEdit.length, 2, 'verifyEdit must take only an edit and the resume');
});

// ---------------------------------------------------------------------------
// And the edits that must get through, or the feature is useless
// ---------------------------------------------------------------------------

test('a pure rephrasing with no new claims is accepted', () => {
  // Nothing added: the same two clouds, the same team, stronger verb. This is
  // what the feature is FOR, and a check that rejected it would be worthless.
  const c = verifyEdit(
    edit(
      'Managed cloud infrastructure for the platform team across AWS and Azure.',
      'Ran multi-region AWS and Azure infrastructure for the platform team.',
    ),
    RESUME,
  );
  assert.equal(c.verdict, 'accepted', c.note);
  assert.deepEqual(c.unverified, []);
});

test('a number carried across from the line being replaced is not re-questioned', () => {
  // "12 minutes" is already in the original, so it is the person's own claim
  // travelling with the edit. Re-proving it would flag every edit that correctly
  // preserved a figure.
  const c = verifyEdit(
    edit(
      'Built CI/CD pipelines with Docker and Kubernetes, cutting deploy time to 12 minutes.',
      'Cut deploy time to 12 minutes with Docker and Kubernetes CI/CD pipelines.',
    ),
    RESUME,
  );
  assert.equal(c.verdict, 'accepted', c.note);
});

test('a number found elsewhere in the resume is accepted', () => {
  // The 40 lives in the Beta Ltd role; moving it into a different bullet is a
  // claim the resume already makes.
  const c = verifyEdit(
    edit('Owned the Terraform estate and the Linux fleet.', 'Owned Terraform and Linux across 40 pipelines.'),
    RESUME,
  );
  assert.equal(c.verdict, 'accepted', c.note);
});

test('a true-by-definition abbreviation is accepted', () => {
  // K8s and Kubernetes are one skill written two ways. Flagging this would train
  // a person to ignore the warnings, which is worse than not warning.
  const c = verifyEdit(
    edit('Owned the Terraform estate and the Linux fleet.', 'Owned the Terraform, K8s and Linux estate.'),
    RESUME,
  );
  assert.equal(c.verdict, 'accepted', c.note);
});

// ---------------------------------------------------------------------------
// The boundary bug that would have made the whole check a decoration
// ---------------------------------------------------------------------------

test('A NUMBER IS NOT VERIFIED BY APPEARING INSIDE ANOTHER NUMBER', () => {
  // The silent failure. `resume.includes('40')` is true of a resume that only
  // ever mentions the year 2040, so a fabricated "40% growth" would verify
  // against text that says nothing of the kind — the check passing for the wrong
  // reason, which is worse than no check because it reports success.
  assert.equal(containsClaim('Led the 2040 strategy programme', '40'), false);
  assert.equal(containsClaim('Revenue of $1,409 per seat', '40'), false);
  assert.equal(containsClaim('Grew revenue 40% year on year', '40'), true);
});

test('the same number written two ways is the same number', () => {
  assert.equal(containsClaim('Processed 15,000 events a second', '15000'), true);
  assert.equal(containsClaim('Processed 15000 events a second', '15,000'), true);
});

test('a token ending in a symbol is still matched', () => {
  // \b between '%' and a space never matches, so a naive word boundary would
  // fail to find a percentage that genuinely is present.
  assert.equal(containsClaim('Improved latency 40% overall', '40%'), true);
  assert.equal(containsClaim('Wrote C++ for the parser', 'c++'), true);
});

test('a claim token is matched case-insensitively', () => {
  assert.equal(containsClaim('Ran KUBERNETES in anger', 'kubernetes'), true);
});

// ---------------------------------------------------------------------------
// What counts as a claim, and what is just English
// ---------------------------------------------------------------------------

test('ordinary words are not treated as claims', () => {
  // If every word had to appear in the source, no rephrasing could ever pass and
  // the feature would return nothing at all.
  assert.deepEqual(claimTokens('Ran the platform team and owned delivery'), []);
});

test('numbers and technical names are treated as claims', () => {
  const got = claimTokens('Cut spend 40% using Terraform, CI/CD and PostgreSQL since 2019');
  for (const want of ['40%', 'terraform', 'ci/cd', 'postgresql', '2019']) {
    assert.ok(got.includes(want), `${want} was not recognised as a claim: ${got.join(',')}`);
  }
});

test('punctuation is trimmed without tearing a name apart', () => {
  // Splitting on punctuation would turn CI/CD into "ci" and "cd" and Node.js into
  // "node" and "js", none of which are the thing being claimed.
  assert.ok(claimTokens('Used CI/CD, Node.js; and AWS.').includes('ci/cd'));
  assert.ok(claimTokens('Used CI/CD, Node.js; and AWS.').includes('node.js'));
  assert.ok(claimTokens('Used CI/CD, Node.js; and AWS.').includes('aws'));
});

test('a number that asserts nothing is not a claim', () => {
  // "24/7" is a turn of phrase in job adverts, not an achievement, and demanding
  // the resume contain it would flag honest edits.
  assert.deepEqual(claimTokens('Provided 24/7 on-call cover'), []);
});

// ---------------------------------------------------------------------------
// Structural faults
// ---------------------------------------------------------------------------

test('AN EDIT TO A LINE THAT DOES NOT EXIST IS REJECTED', () => {
  // A model that invented the line it is editing invented the whole edit, and
  // applying it would ADD a sentence rather than change one. This is also what
  // makes a stale resume safe: edits computed against an older version stop
  // matching instead of landing on the wrong text.
  const c = verifyEdit(
    edit('Led a team of 40 engineers at Google.', 'Led a team of 40 engineers at Google, scaling to 60.'),
    RESUME,
  );
  assert.equal(c.verdict, 'rejected');
  assert.match(c.note, /not in your resume/);
});

test('an edit that changes nothing is rejected', () => {
  const line = 'Owned the Terraform estate and the Linux fleet.';
  assert.equal(verifyEdit(edit(line, line), RESUME).verdict, 'rejected');
  // Whitespace and case are not a change either.
  assert.equal(verifyEdit(edit(line, `  ${line.toUpperCase()}  `), RESUME).verdict, 'rejected');
});

test('PADDING IS REJECTED EVEN WHEN EVERY CLAIM CHECKS OUT', () => {
  // Bloat is the AI tell people actually notice, and it can be built entirely
  // from words already in the resume — so the claim check cannot catch it and a
  // separate length rule is required.
  const c = verifyEdit(
    edit(
      'Owned the Terraform estate and the Linux fleet.',
      'Owned, managed, maintained and continuously improved the Terraform estate and the Linux fleet, ' +
        'working across AWS and Azure with Docker and Kubernetes and Python and SQL and dbt.',
    ),
    RESUME,
  );
  assert.equal(c.verdict, 'rejected');
  assert.match(c.note, /padding/);
});

test('a short line gets absolute slack rather than the ratio', () => {
  // 1.6x of a 12-character bullet is 19 characters, which would reject almost any
  // real improvement to a short line.
  assert.ok(growthCeiling('Ran the SRE') > 'Ran the SRE'.length * MAX_GROWTH);
  const c = verifyEdit(edit('Ran the Linux fleet.', 'Ran the Linux and Docker fleet.'), RESUME);
  assert.equal(c.verdict, 'rejected', 'that line is not in the resume verbatim');
});

test('missing and empty fields are rejected rather than crashing', () => {
  for (const bad of [
    { original: '', replacement: 'something', reason: 'r' },
    { original: 'Owned the Terraform estate and the Linux fleet.', replacement: '', reason: 'r' },
    { original: '   ', replacement: '   ', reason: 'r' },
  ]) {
    assert.equal(verifyEdit(bad, RESUME).verdict, 'rejected');
  }
  // And a model returning the wrong shape entirely.
  const nothing = verifyEdit({} as Edit, RESUME);
  assert.equal(nothing.verdict, 'rejected');
});

test('an absurdly long replacement is rejected before anything else is measured', () => {
  const c = verifyEdit(
    edit('Owned the Terraform estate and the Linux fleet.', 'x'.repeat(5_000)),
    RESUME,
  );
  assert.equal(c.verdict, 'rejected');
  assert.match(c.note, /not a resume line/);
});

test('an empty resume accepts nothing', () => {
  // The state every account is in until someone pastes a CV. It must refuse
  // rather than verify against nothing, which would accept every edit.
  const c = verifyEdit(edit('anything at all', 'anything at all, improved'), '');
  assert.equal(c.verdict, 'rejected');
});

// ---------------------------------------------------------------------------
// Counting, because "is this too strict" is an empirical question
// ---------------------------------------------------------------------------

test('a set of edits is summarised so strictness can be measured', () => {
  const summary = verifyEdits(
    [
      // accepted
      edit(
        'Managed cloud infrastructure for the platform team across AWS and Azure.',
        'Ran multi-region AWS and Azure infrastructure for the platform team.',
      ),
      // flagged
      edit(
        'Ran Streaming ingestion and Orchestration for 40 daily pipelines.',
        'Ran Kafka ingestion and Orchestration for 40 daily pipelines.',
      ),
      // rejected
      edit('A line from somebody else CV', 'A line from somebody else CV, but better'),
    ],
    RESUME,
  );

  assert.equal(summary.accepted, 1);
  assert.equal(summary.flagged, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.checked.length, 3);
  assert.match(summary.note, /1 verified/);
  assert.match(summary.note, /1 need your judgement/);
  assert.match(summary.note, /1 discarded/);
});

test('normalise only touches whitespace and case', () => {
  assert.equal(normalise('  Ran   the\n\nfleet '), 'ran the fleet');
});
