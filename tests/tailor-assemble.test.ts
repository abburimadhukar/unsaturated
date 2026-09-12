import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyEdits } from '../src/tailor/assemble.js';
import type { Edit } from '../src/tailor/edits.js';

/**
 * Turning accepted changes into a document.
 *
 * This is the step where a mistake produces a DAMAGED RESUME rather than an error
 * message — a line replaced twice, a change quietly dropped, a bullet rewritten
 * where it was not meant to be. A person sends that file to an employer. So the
 * failures worth testing here are the silent ones.
 */

const RESUME = [
  'Madhukar Abburi — Platform and Data Engineer',
  '',
  'EXPERIENCE',
  'Senior Platform Engineer, Acme Corp, 2021 to present',
  'Managed cloud infrastructure for the platform team across AWS and Azure.',
  'Built CI/CD pipelines with Docker and Kubernetes, cutting deploy time to 12 minutes.',
  'Data Engineer, Beta Ltd, 2019 to 2021',
  'Wrote Python and SQL for the warehouse.',
  'Wrote Python and SQL for the warehouse.',
  '',
  'SKILLS',
  'AWS, Azure, Kubernetes, Terraform, Docker, CI/CD, Linux, Python, SQL, dbt',
].join('\n');

const edit = (original: string, replacement: string): Edit => ({
  original,
  replacement,
  reason: 'because',
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('an accepted edit lands on its line and nothing else moves', () => {
  const res = applyEdits(RESUME, [
    edit(
      'Managed cloud infrastructure for the platform team across AWS and Azure.',
      'Ran multi-region AWS and Azure infrastructure for the platform team.',
    ),
  ]);
  assert.equal(res.applied, 1);
  assert.deepEqual(res.refused, []);
  assert.ok(res.changed);

  const before = RESUME.split('\n');
  const after = res.text.split('\n');
  assert.equal(after.length, before.length, 'the line count changed');
  // Exactly one line differs.
  const differing = after.filter((l, i) => l !== before[i]);
  assert.equal(differing.length, 1);
  assert.equal(differing[0], 'Ran multi-region AWS and Azure infrastructure for the platform team.');
});

test('several edits all land, each on its own line', () => {
  const res = applyEdits(RESUME, [
    edit(
      'Managed cloud infrastructure for the platform team across AWS and Azure.',
      'Ran AWS and Azure infrastructure for the platform team.',
    ),
    edit(
      'Built CI/CD pipelines with Docker and Kubernetes, cutting deploy time to 12 minutes.',
      'Cut deploy time to 12 minutes with Docker and Kubernetes CI/CD pipelines.',
    ),
  ]);
  assert.equal(res.applied, 2);
  assert.equal(res.refused.length, 0);
  assert.ok(res.text.includes('Ran AWS and Azure'));
  assert.ok(res.text.includes('Cut deploy time to 12 minutes'));
});

test('nothing accepted means the resume comes back untouched', () => {
  const res = applyEdits(RESUME, []);
  assert.equal(res.text, RESUME);
  assert.equal(res.applied, 0);
  assert.equal(res.changed, false);
});

// ---------------------------------------------------------------------------
// The silent damage this file exists to prevent
// ---------------------------------------------------------------------------

test('A REPEATED LINE IS NOT REWRITTEN TWICE BY TWO DIFFERENT EDITS', () => {
  // The resume says "Wrote Python and SQL for the warehouse." twice, which is
  // ordinary — two roles, the same work. A naive String.replace hits the FIRST
  // occurrence both times, so the second edit silently overwrites the first and
  // one of the two lines is never touched.
  const res = applyEdits(RESUME, [
    edit('Wrote Python and SQL for the warehouse.', 'Built Python and SQL warehouse models.'),
    edit('Wrote Python and SQL for the warehouse.', 'Wrote Python, SQL and dbt for the warehouse.'),
  ]);

  assert.equal(res.applied, 2, 'both edits must land somewhere');
  assert.ok(res.text.includes('Built Python and SQL warehouse models.'));
  assert.ok(res.text.includes('Wrote Python, SQL and dbt for the warehouse.'));
  // And the original line is gone from both places rather than one.
  assert.equal(
    res.text.split('\n').filter((l) => l === 'Wrote Python and SQL for the warehouse.').length,
    0,
  );
});

test('AN EDIT THAT CANNOT LAND IS REPORTED, NEVER SILENTLY DROPPED', () => {
  // Somebody clicked "use this". If it does not appear in the document and nothing
  // says so, the document is not what they approved — and they have no way to tell.
  const res = applyEdits(RESUME, [
    edit('A line from somebody else resume', 'Improved somehow'),
  ]);
  assert.equal(res.applied, 0);
  assert.equal(res.refused.length, 1);
  assert.ok(res.refused[0]!.why.length > 0, 'a refusal with no reason is a silent drop');
  assert.equal(res.text, RESUME, 'the resume must be untouched when nothing applied');
});

test('two edits claiming the same single line: one lands, the other is explained', () => {
  const line = 'Managed cloud infrastructure for the platform team across AWS and Azure.';
  const res = applyEdits(RESUME, [
    edit(line, 'Ran AWS and Azure infrastructure for the platform team.'),
    edit(line, 'Owned AWS and Azure infrastructure for the platform team.'),
  ]);
  assert.equal(res.applied, 1);
  assert.equal(res.refused.length, 1);
  assert.match(res.refused[0]!.why, /already changed/i);
});

test('AN EDIT ANCHORED TO TEXT THAT IS NOT IN THE RESUME REACHES NOTHING', () => {
  // The edits arrive from a browser, which means they arrive from whatever the
  // browser chose to send. An anchor that is not in the document cannot be applied
  // anywhere, so the claim it carries never lands.
  //
  // Note what this test does NOT claim. A fabricated NUMBER on a real line is
  // flagged rather than refused, and an accepted flag is applied deliberately —
  // see the judgement-call test below. What is refused is an edit that is
  // structurally unusable.
  const res = applyEdits(RESUME, [
    edit('Not a line in this resume at all', 'Cut infrastructure spend 40%.'),
  ]);
  assert.equal(res.applied, 0);
  assert.equal(res.refused.length, 1);
  assert.ok(!res.text.includes('40%'), 'an unanchored claim reached the document');
});

test('RE-VERIFICATION ACTUALLY RUNS, NOT JUST THE LINE LOOKUP', () => {
  // The previous test passes whether or not verifyEdit is called, because its
  // anchor is missing and the line lookup refuses it either way. This one has a
  // PRESENT anchor and a replacement only verifyEdit can reject — so it fails if
  // the check is skipped, which is exactly what a mutation removing it proved.
  const line = 'Wrote Python and SQL for the warehouse.';
  const res = applyEdits(RESUME, [edit(line, line)]);
  assert.equal(res.applied, 0, 'a no-op edit was applied, so nothing is being re-verified');
  assert.equal(res.refused.length, 1);
  assert.match(res.refused[0]!.why, /same as the original/i);
});

test('AN EDIT CANNOT LAND ON A LINE A PREVIOUS EDIT JUST WROTE', () => {
  // The case the claimed-line set exists for, and the only one that needs it.
  // Edit A rewrites line 1 into text that happens to be edit B's anchor. Without
  // the set, B's search finds line 1 — the text A just produced — and rewrites
  // that instead of the person's own second line, which is then left untouched.
  //
  // Verified: with the set, "Ran the Linux fleet." / "Ran the Linux and Docker
  // fleet."  Without it, the two lines come out the wrong way round and one of
  // the person's own lines is never edited.
  const resume = ['Owned the Terraform estate.', 'Ran the Linux fleet.'].join('\n');
  const res = applyEdits(resume, [
    edit('Owned the Terraform estate.', 'Ran the Linux fleet.'),
    edit('Ran the Linux fleet.', 'Ran the Linux and Docker fleet.'),
  ]);
  assert.equal(res.applied, 2);
  assert.deepEqual(res.text.split('\n'), [
    'Ran the Linux fleet.',
    'Ran the Linux and Docker fleet.',
  ]);
});

test('padding is refused at this stage too', () => {
  const res = applyEdits(RESUME, [
    edit(
      'Wrote Python and SQL for the warehouse.',
      'Wrote, maintained, improved and continuously optimised Python and SQL for the warehouse, ' +
        'working with AWS, Azure, Kubernetes, Terraform, Docker, CI/CD, Linux and dbt throughout.',
    ),
  ]);
  assert.equal(res.applied, 0);
  assert.match(res.refused[0]!.why, /padding/i);
});

test('AN EDIT THE PERSON ACCEPTED DESPITE A WARNING IS APPLIED', () => {
  // A flagged edit adds something the resume does not say. Accepting it is a claim
  // the person is making about their own history, and they are entitled to make
  // it — the feature's job was to show them they were making it, which it did.
  const res = applyEdits(RESUME, [
    edit(
      'Wrote Python and SQL for the warehouse.',
      'Wrote Python and SQL for the Snowflake warehouse.',
    ),
  ]);
  assert.equal(res.applied, 1, 'an accepted judgement call was thrown away');
  assert.ok(res.text.includes('Snowflake'));
});

// ---------------------------------------------------------------------------
// Drift, and lines that are not quite lines
// ---------------------------------------------------------------------------

test('a line quoted with different spacing still matches', () => {
  // Models reflow whitespace. Refusing over a double space would drop a perfectly
  // good edit and report it as a missing line.
  const res = applyEdits(RESUME, [
    edit(
      'Managed   cloud infrastructure  for the platform team across AWS and Azure.',
      'Ran AWS and Azure infrastructure for the platform team.',
    ),
  ]);
  assert.equal(res.applied, 1, res.refused[0]?.why);
});

test('a sentence quoted from inside a longer line is replaced in place', () => {
  // Some CVs put a whole role on one line. Replacing the entire line would delete
  // the rest of it.
  const oneLine = 'Acme Corp, 2021 to present. Managed the cloud estate. Mentored two juniors.';
  const res = applyEdits(oneLine, [
    edit('Managed the cloud estate.', 'Ran the cloud estate.'),
  ]);
  assert.equal(res.applied, 1, res.refused[0]?.why);
  assert.ok(res.text.startsWith('Acme Corp, 2021 to present.'), 'the line prefix was lost');
  assert.ok(res.text.endsWith('Mentored two juniors.'), 'the line suffix was lost');
  assert.ok(res.text.includes('Ran the cloud estate.'));
});

test('an empty resume applies nothing and returns nothing', () => {
  const res = applyEdits('', [edit('anything', 'anything better')]);
  assert.equal(res.applied, 0);
  assert.equal(res.text, '');
  assert.equal(res.changed, false);
});

test('blank lines and section headings survive untouched', () => {
  // A resume's shape is carried by its blank lines. Losing them turns a structured
  // document into a paragraph.
  const res = applyEdits(RESUME, [
    edit('Wrote Python and SQL for the warehouse.', 'Built Python and SQL warehouse models.'),
  ]);
  const before = RESUME.split('\n');
  const after = res.text.split('\n');
  for (const i of [1, 2, 9, 10]) {
    assert.equal(after[i], before[i], `line ${i} ("${before[i]}") changed and should not have`);
  }
});
