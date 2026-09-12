import { test } from 'node:test';
import assert from 'node:assert/strict';

import { changeRatio, diffWords, words, type Span } from '../src/tailor/diff.js';

/**
 * Making "the least possible change" checkable.
 *
 * A before-and-after pair proves nothing — two sentences one above the other look
 * equally different whether four words moved or fourteen. Marking the individual
 * words is what lets a person see the claim is true, and what lets them rewrite a
 * phrase in their own voice, which is the habit that keeps a tailored CV from
 * reading as machine-written.
 */

const text = (spans: Span[], op: Span['op']) =>
  spans.filter((s) => s.op === op).map((s) => s.text).join(' ');
const shown = (spans: Span[]) =>
  spans.filter((s) => s.op !== 'removed').map((s) => s.text).join(' ');

// ---------------------------------------------------------------------------
// The basics
// ---------------------------------------------------------------------------

test('an unchanged line has nothing added or removed', () => {
  const spans = diffWords('Owned the Terraform estate', 'Owned the Terraform estate');
  assert.deepEqual(spans, [{ op: 'same', text: 'Owned the Terraform estate' }]);
  assert.equal(changeRatio('Owned the Terraform estate', 'Owned the Terraform estate'), 0);
});

test('ONE SWAPPED WORD MARKS ONE WORD, NOT THE REST OF THE LINE', () => {
  // The failure the cheap algorithm produces: walk until the words differ, then
  // call everything after it a rewrite. Here that would mark four words changed
  // instead of one, and the feature's central claim with it.
  const before = 'Managed cloud infrastructure for the platform team';
  const after = 'Ran cloud infrastructure for the platform team';
  const spans = diffWords(before, after);
  assert.equal(text(spans, 'removed'), 'Managed');
  assert.equal(text(spans, 'added'), 'Ran');
  assert.equal(text(spans, 'same'), 'cloud infrastructure for the platform team');
});

test('A REORDERING IS NOT REPORTED AS A REWRITE', () => {
  // Reordering is one of the six things the feature offers — "Lead with my best"
  // does nothing else. A diff that walks forward until the lines differ marks the
  // whole line as changed here, which would make the most common edit look like
  // the most invasive one.
  const before = 'Built CI/CD pipelines with Docker and Kubernetes, cutting deploy time to 12 minutes';
  const after = 'Cutting deploy time to 12 minutes with Docker and Kubernetes CI/CD pipelines';
  // Exactly one word actually leaves: "Built". Everything else is the same
  // content in a different order, and a reorder changes no claim.
  const ratio = changeRatio(before, after);
  assert.ok(ratio < 0.15, `a reorder was reported as ${Math.round(ratio * 100)}% changed`);

  // The SPANS still show it as a removal and an addition, because a sequence diff
  // cannot express a move and a reader does need to see where the words went.
  // That is the difference between the two functions, and the reason the ratio is
  // not counted off the spans.
  const spans = diffWords(before, after);
  const movedWords = words(text(spans, 'removed')).length;
  assert.ok(movedWords > 1, 'the spans are expected to show the move as remove-plus-add');
});

test('an insertion is marked as added and nothing is removed', () => {
  const spans = diffWords('Ran AWS infrastructure', 'Ran multi-region AWS infrastructure');
  assert.equal(text(spans, 'added'), 'multi-region');
  assert.equal(text(spans, 'removed'), '');
});

test('a deletion is marked as removed and nothing is added', () => {
  const spans = diffWords('Owned the entire Terraform estate', 'Owned the Terraform estate');
  assert.equal(text(spans, 'removed'), 'entire');
  assert.equal(text(spans, 'added'), '');
});

// ---------------------------------------------------------------------------
// What counts as the same word
// ---------------------------------------------------------------------------

test('case and trailing punctuation do not count as a change', () => {
  // Otherwise moving a word to the start of a sentence, or to the end of one,
  // registers as a rewrite of that word.
  const spans = diffWords('owned the fleet', 'Owned the fleet.');
  assert.equal(text(spans, 'removed'), '');
  assert.equal(text(spans, 'added'), '');
});

test('THE TEXT SHOWN IS THE RESULT, NOT THE ORIGINAL', () => {
  // "owned" and "Owned." compare equal, but the person is going to paste what is
  // on screen into their CV — so the kept spans must carry the AFTER spelling.
  const spans = diffWords('owned the fleet', 'Owned the fleet.');
  assert.equal(shown(spans), 'Owned the fleet.');
});

test('punctuation stays attached to its word', () => {
  // Split off, a comma becomes an independent change every time a list is
  // reordered, and every reorder then looks like heavy editing.
  assert.deepEqual(words('Docker, Kubernetes and Terraform.'), [
    'Docker,',
    'Kubernetes',
    'and',
    'Terraform.',
  ]);
});

test('a technical name with inner punctuation is one word', () => {
  assert.deepEqual(words('Used CI/CD and Node.js'), ['Used', 'CI/CD', 'and', 'Node.js']);
  // And CI/CD matches itself across a change elsewhere in the line.
  const spans = diffWords('Built CI/CD with Docker', 'Ran CI/CD with Docker');
  assert.ok(text(spans, 'same').includes('CI/CD'));
});

// ---------------------------------------------------------------------------
// Spans as the UI needs them
// ---------------------------------------------------------------------------

test('adjacent spans of the same kind are merged', () => {
  // Each span gets a background in the UI. One element per word is a hundred
  // boxes and unreadable.
  const spans = diffWords('a b c d e', 'a x y d e');
  assert.deepEqual(spans, [
    { op: 'same', text: 'a' },
    { op: 'removed', text: 'b c' },
    { op: 'added', text: 'x y' },
    { op: 'same', text: 'd e' },
  ]);
});

test('every word of both lines survives into the spans', () => {
  // The diff is what the person reads instead of the two lines, so losing a word
  // here loses it from their view of the change.
  const before = 'Managed cloud infrastructure for the platform team across AWS and Azure';
  const after = 'Ran multi-region AWS and Azure infrastructure for the platform team';
  const spans = diffWords(before, after);
  const kept = spans.filter((s) => s.op !== 'added').flatMap((s) => words(s.text));
  const produced = spans.filter((s) => s.op !== 'removed').flatMap((s) => words(s.text));
  assert.equal(kept.length, words(before).length, 'a word of the original vanished');
  assert.equal(produced.length, words(after).length, 'a word of the replacement vanished');
});

// ---------------------------------------------------------------------------
// The ratio
// ---------------------------------------------------------------------------

test('the ratio measures how much of the ORIGINAL was touched', () => {
  // "How much of what I wrote did this change", not "how much of the result is
  // new" — a line that doubles in length while keeping every original word has
  // not changed what the person claimed.
  assert.equal(changeRatio('a b c d', 'a b c d e f g h'), 0);
  assert.equal(changeRatio('a b c d', 'a b'), 0.5);
});

test('the ratio is bounded and never NaN', () => {
  assert.equal(changeRatio('', ''), 0);
  assert.equal(changeRatio('', 'something new'), 1);
  assert.equal(changeRatio('a b', ''), 1);
  for (const r of [changeRatio('a', 'b'), changeRatio('a b c', 'x y z')]) {
    assert.ok(r >= 0 && r <= 1, `ratio out of range: ${r}`);
  }
});

test('a whole-line rewrite reads as a whole-line rewrite', () => {
  assert.equal(changeRatio('Managed the cloud estate', 'Kafka Airflow Snowflake dbt'), 1);
});

test('A PURE REORDER CHANGES NO CONTENT, SO THE RATIO IS ZERO', () => {
  // The property the corrected definition exists for. Same words, different
  // order, nothing claimed that was not claimed before.
  assert.equal(changeRatio('Docker and Kubernetes', 'Kubernetes and Docker'), 0);
});

test('a word used twice and kept once counts as one loss', () => {
  // A multiset and not a set. With a set, dropping one of two mentions would
  // score zero change, which understates an edit that did remove something.
  assert.ok(changeRatio('data data pipelines', 'data pipelines') > 0);
  assert.equal(changeRatio('data data pipelines', 'data data pipelines'), 0);
});
