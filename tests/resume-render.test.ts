import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { changedLines, readResume } from '../src/ui/resume-render.js';

/**
 * Reading plain text as a document, so it can be shown as one.
 *
 * The tailored resume used to come back in a monospace box. Everything was there
 * and none of it looked like a resume, which made the only question a person has —
 * "would I send this?" — unanswerable from the screen.
 *
 * What these tests mostly guard is that the reading does not LOSE anything. A
 * dropped blank line, a bullet rendered flush left, a heading missed: each one
 * turns a structured document back into a wall of text, which is the thing this
 * exists to stop.
 */

const RESUME = [
  'Madhukar Abburi',
  'madhukar@example.com · +44 7700 900000 · linkedin.com/in/example',
  '',
  'EXPERIENCE',
  'Senior Platform Engineer, Acme Corp, 2021 to present',
  '- Ran multi-region AWS and Azure infrastructure for the platform team.',
  '- Cut deploy time to 12 minutes with Docker and Kubernetes CI/CD pipelines.',
  '  Worked alongside the SRE team on the rollout.',
  '',
  'TECHNICAL SKILLS',
  'AWS, Azure, Kubernetes, Terraform, Docker, CI/CD, Linux, Python, SQL, dbt',
].join('\n');

const kinds = (text: string) => readResume(text).map((b) => b.kind);

// ---------------------------------------------------------------------------
// Nothing may be lost
// ---------------------------------------------------------------------------

test('EVERY LINE BECOMES EXACTLY ONE BLOCK', () => {
  // The preview is what a person checks the document by. A line that vanishes here
  // is a line they will not notice is missing until an employer reads it.
  const lines = RESUME.split('\n');
  const blocks = readResume(RESUME);
  assert.equal(blocks.length, lines.length);
  assert.deepEqual(blocks.map((b) => b.line), lines.map((_, i) => i));
});

test('BLANK LINES SURVIVE, BECAUSE THEY CARRY THE STRUCTURE', () => {
  // Drop them and a resume becomes one block of prose with bold words in it.
  assert.equal(kinds('One\n\nTwo').filter((k) => k === 'blank').length, 1);
  assert.equal(readResume('a\n\n\nb').filter((b) => b.kind === 'blank').length, 2);
});

test('no text is altered on the way through', () => {
  // Only the bullet marker is removed, and it comes back in `marker` so it can be
  // drawn. Everything else is the person's words, untouched.
  for (const b of readResume(RESUME)) {
    if (b.kind === 'blank') continue;
    const source = RESUME.split('\n')[b.line]!;
    assert.ok(
      source.includes(b.text),
      `block text "${b.text}" is not in its source line "${source}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// What each line is
// ---------------------------------------------------------------------------

test('the first non-empty line is the name, whatever it says', () => {
  assert.equal(readResume(RESUME)[0]!.kind, 'name');
  // Even when it is preceded by blank lines, which a pasted CV often is.
  assert.equal(readResume('\n\n  Jane Doe\nrest')[2]!.kind, 'name');
});

test('contact details under the name are recognised', () => {
  const blocks = readResume(RESUME);
  assert.equal(blocks[1]!.kind, 'contact');
});

test('A URL FURTHER DOWN IS NOT A CONTACT BLOCK', () => {
  // A project link inside a bullet would otherwise be pulled out and formatted as
  // a header, halfway down the page.
  const text = ['Jane Doe', '', 'PROJECTS', '', '', '', 'Built it — see github.com/jane/thing'].join(
    '\n',
  );
  const blocks = readResume(text);
  assert.equal(blocks[blocks.length - 1]!.kind, 'body');
});

test('bullets are recognised and their marker is kept separately', () => {
  const blocks = readResume(RESUME);
  const bullets = blocks.filter((b) => b.kind === 'bullet');
  assert.ok(bullets.length >= 2);
  assert.equal(bullets[0]!.marker, '-');
  assert.ok(!bullets[0]!.text.startsWith('-'), 'the marker is still in the text');
});

test('every bullet character people actually use is recognised', () => {
  for (const marker of ['-', '–', '—', '•', '*', '·', '▪', '‣', '◦']) {
    const blocks = readResume(`Name\n${marker} did a thing`);
    assert.equal(blocks[1]!.kind, 'bullet', `${marker} was not read as a bullet`);
    assert.equal(blocks[1]!.text, 'did a thing');
  }
});

test('AN INDENTED LINE WITH NO MARKER IS STILL A SUB-POINT', () => {
  // The indentation is the only thing saying so, and rendering it flush left
  // loses it — the continuation of a bullet reads as a new top-level claim.
  const blocks = readResume(RESUME);
  const continuation = blocks.find((b) => b.text.startsWith('Worked alongside'));
  assert.ok(continuation);
  assert.equal(continuation.kind, 'bullet');
});

test('section headings use the same test as the .docx writer', () => {
  const blocks = readResume(RESUME);
  assert.deepEqual(
    blocks.filter((b) => b.kind === 'heading').map((b) => b.text),
    ['EXPERIENCE', 'TECHNICAL SKILLS'],
  );
});

test('THE HEADING TEST IS IMPORTED, NOT COPIED', () => {
  // Two copies drift, and the symptom is a preview that bolds a line the
  // downloaded file does not — the preview lying about the document in the one way
  // that matters.
  const src = readFileSync(new URL('../src/ui/resume-render.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{ looksLikeHeading \} from '\.\/docx\.js'/);
  assert.ok(!/function looksLikeHeading/.test(src), 'the heading test was copied');
});

test('a job title line is body text, not a heading', () => {
  // It has lowercase, so it is prose. Bolding it would make every role look like a
  // section.
  const blocks = readResume(RESUME);
  const role = blocks.find((b) => b.text.startsWith('Senior Platform Engineer'));
  assert.equal(role?.kind, 'body');
});

test('an empty document reads as no blocks rather than crashing', () => {
  assert.deepEqual(readResume(''), [{ kind: 'blank', text: '', line: 0 }]);
});

test('windows line endings do not produce stray blocks', () => {
  assert.deepEqual(kinds('Name\r\n\r\nEXPERIENCE'), ['name', 'blank', 'heading']);
});

// ---------------------------------------------------------------------------
// Marking what changed
// ---------------------------------------------------------------------------

test('AN ACCEPTED REPLACEMENT IS MARKED IN THE DOCUMENT', () => {
  // The whole point of showing the resume rather than a list of edits: seeing the
  // change in the context it will be read in.
  const marked = changedLines(RESUME, [
    'Ran multi-region AWS and Azure infrastructure for the platform team.',
  ]);
  assert.equal(marked.size, 1);
  assert.ok(marked.has(5), `marked the wrong line: ${[...marked]}`);
});

test('the bullet marker does not stop a line being matched', () => {
  // The replacement the model produced has no "- " on the front; the line in the
  // document does.
  const marked = changedLines('Name\n- Ran the AWS estate', ['Ran the AWS estate']);
  assert.ok(marked.has(1));
});

test('whitespace differences do not stop a line being matched', () => {
  const marked = changedLines('Name\n-  Ran   the  AWS estate', ['Ran the AWS estate']);
  assert.ok(marked.has(1));
});

test('a replacement spliced into a longer line still marks that line', () => {
  // The assembler replaces a quoted sentence inside a line for CVs that put a
  // whole role on one line.
  const marked = changedLines('Acme, 2021. Ran the AWS estate. Mentored two.', ['Ran the AWS estate.']);
  assert.ok(marked.has(0));
});

test('EVERY OCCURRENCE IS MARKED, NOT JUST THE FIRST', () => {
  // Two accepted edits can share wording, and a resume repeats lines. Marking one
  // of them would show a document that looks half-tailored.
  const text = 'Name\n- Ran the AWS estate\n- Ran the AWS estate';
  const marked = changedLines(text, ['Ran the AWS estate']);
  assert.equal(marked.size, 2);
});

test('nothing accepted marks nothing', () => {
  assert.equal(changedLines(RESUME, []).size, 0);
  assert.equal(changedLines(RESUME, ['', '   ']).size, 0);
});

test('an unrelated replacement marks nothing', () => {
  assert.equal(changedLines(RESUME, ['A line from somebody else CV']).size, 0);
});
