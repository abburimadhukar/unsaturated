import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { linesFromItems, type TextItem } from '../src/ui/pdf-lines.js';

/**
 * Putting the lines back into a PDF resume.
 *
 * THE BUG THIS EXISTS FOR
 *
 * The reader joined every text item on a page with a space and collapsed all
 * whitespace, so a page came out as ONE line. Everything was there and none of
 * the structure was — and structure is what every later step reads: readResume
 * renders headings and bullets from it, the .docx writer bolds headings from it,
 * applyEdits splices line by line. Fed a single 4,000-character line they all
 * degrade to "one paragraph", and somebody's CV comes back as a wall of prose.
 *
 * A PDF has no lines. It has glyphs at coordinates, and a line is something a
 * reader infers from where they sit — so these tests are coordinates.
 */

/** An item at (x, y), `w` wide and `h` tall. y grows UPWARDS, as in a PDF. */
const at = (str: string, x: number, y: number, w: number, h = 10): TextItem => ({
  str,
  transform: [h, 0, 0, h, x, y],
  width: w,
  height: h,
});

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

test('ITEMS SHARING A BASELINE ARE ONE LINE, AND A NEW BASELINE IS A NEW LINE', () => {
  const out = linesFromItems([
    at('MADHUKAR ABBURI', 50, 700, 120),
    at('Software Engineer', 50, 686, 100),
  ]);
  assert.equal(out, 'MADHUKAR ABBURI\nSoftware Engineer');
});

test('the whole page is no longer one line', () => {
  // The literal regression. Three rows of text must not come back as one.
  const out = linesFromItems([
    at('EXPERIENCE', 50, 600, 80),
    at('Built services', 50, 586, 70),
    at('Ran the platform', 50, 572, 80),
  ]);
  assert.equal(out.split('\n').length, 3, `came back as: ${JSON.stringify(out)}`);
});

test('glyphs are read in reading order, not the order the PDF stored them', () => {
  // A writer emits glyphs in whatever order suits it — commonly all of one font
  // before all of another, so a heading can be written after the body under it.
  const out = linesFromItems([
    at('second', 50, 500, 40),
    at('first', 50, 520, 30),
    at('third', 50, 480, 30),
  ]);
  assert.equal(out, 'first\nsecond\nthird');
});

test('a line is assembled left to right whatever order its runs arrive in', () => {
  const out = linesFromItems([
    at('World', 100, 400, 40),
    at('Hello', 50, 400, 40),
  ]);
  assert.equal(out, 'Hello World');
});

test('a small baseline shift is still the same line', () => {
  // Superscripts and mixed fonts nudge a baseline. A real new line moves it by a
  // whole line, so the tolerance is a fraction of the glyph height.
  const out = linesFromItems([
    at('C', 50, 400, 8),
    at('++', 58, 403, 8),
  ]);
  assert.equal(out, 'C++');
});

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

test('A WIDE GAP IS A SPACE AND A TIGHT ONE IS NOT', () => {
  // Both halves matter. Joining every run with a space gives "Ran multi - region
  // AWS"; joining none gives "Ranmulti-regionAWS" — and that second one is the
  // failure that counts, because the first reader of a resume is usually a
  // parser. PDF writers split runs wherever a font or a colour changes.
  const tight = linesFromItems([
    at('Ran', 50, 400, 20),
    at('multi', 70, 400, 28), // no gap: one word split across runs
  ]);
  assert.equal(tight, 'Ranmulti');

  const spaced = linesFromItems([
    at('Ran', 50, 400, 20),
    at('multi', 76, 400, 28), // a real word gap
  ]);
  assert.equal(spaced, 'Ran multi');
});

test('a run that already carries its own space does not get a second one', () => {
  const out = linesFromItems([
    at('Azure ', 50, 400, 34),
    at('DevOps', 90, 400, 40),
  ]);
  assert.equal(out, 'Azure DevOps');
  assert.ok(!out.includes('  '), 'doubled the space');
});

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

test('A BIGGER STEP THAN USUAL IS A PARAGRAPH BREAK', () => {
  // Blank lines are most of how a resume carries its structure: readResume finds
  // a section heading partly by what sits above it.
  const out = linesFromItems([
    at('Built services in .NET', 50, 600, 110),
    at('Ran the platform', 50, 586, 90),
    at('EXPERIENCE', 50, 550, 80), // a gap of 36 against a usual step of 14
    at('Cognizant', 50, 536, 60),
  ]);
  assert.equal(
    out,
    'Built services in .NET\nRan the platform\n\nEXPERIENCE\nCognizant',
  );
});

test('ordinary line spacing is not mistaken for a paragraph', () => {
  const out = linesFromItems([
    at('one', 50, 600, 30),
    at('two', 50, 586, 30),
    at('three', 50, 572, 30),
  ]);
  assert.ok(!out.includes('\n\n'), `invented a paragraph break: ${JSON.stringify(out)}`);
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

test('no text at all is an empty string, not a crash', () => {
  // A scanned CV with no text layer is a real thing people upload. The reader is
  // best effort and the upload never depends on it.
  assert.equal(linesFromItems([]), '');
  assert.equal(linesFromItems([at('   ', 50, 400, 10)]), '');
});

test('an item with no usable transform is skipped rather than throwing', () => {
  const out = linesFromItems([
    { str: 'kept', transform: [10, 0, 0, 10, 50, 400], width: 30, height: 10 },
    { str: 'dropped', transform: [], width: 30 } as TextItem,
  ]);
  assert.equal(out, 'kept');
});

// ---------------------------------------------------------------------------
// What it is all for
// ---------------------------------------------------------------------------

test('THE REBUILT TEXT READS BACK AS A DOCUMENT', () => {
  // The end of the chain, and the actual point. Flattened into one line, every
  // one of these blocks came back as a single `body` and the CV rendered — and
  // downloaded — as a wall of prose.
  const text = linesFromItems([
    at('MADHUKAR ABBURI', 50, 700, 130, 16),
    at('madhukar@example.com · +1 (404) 566-7011', 50, 682, 200, 9),
    at('TECHNICAL SKILLS', 50, 640, 110, 11),
    at('Languages: C#, SQL, Python', 50, 626, 150),
    at('EXPERIENCE', 50, 584, 80, 11),
    at('• Built services in .NET Core', 50, 570, 160),
  ]);

  // Checked on the lines themselves. This used to go through the resume
  // renderer, which was removed with resume tailoring on 25 Sep 2026; what the
  // kept readers — Account-page upload and the browser extension — rely on is
  // that each of these arrives on a line of its own, and that is what's asserted.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.includes('MADHUKAR ABBURI'), 'the name is not a line of its own');
  assert.ok(lines.some((l) => l.startsWith('madhukar@example.com')), 'the contact line is not its own');
  assert.ok(lines.includes('TECHNICAL SKILLS') && lines.includes('EXPERIENCE'), 'a section heading was merged into a neighbour');
  assert.ok(lines.some((l) => l.startsWith('• Built services')), 'the bullet is not its own line');
});

// ---------------------------------------------------------------------------
// The reader is wired to it
// ---------------------------------------------------------------------------

test('the PDF reader uses this and no longer joins the page with spaces', () => {
  const src = readFileSync(new URL('../src/ui/resume-file.ts', import.meta.url), 'utf8');
  assert.match(src, /linesFromItems\(content\.items/);
  assert.ok(
    !/\.join\(' '\)\s*\n\s*\.replace\(\/\\s\+\/g, ' '\)/.test(src),
    'the flattening join is back',
  );
});

// ---------------------------------------------------------------------------
// The .docx side of the same problem: text Word does not show
// ---------------------------------------------------------------------------

test('FIELD CODES AND TRACKED DELETIONS DO NOT REACH THE RESUME', () => {
  // Stripping tags keeps everything between them, and not every text node in a
  // .docx is text the document displays. A field's INSTRUCTIONS were being pasted
  // into the middle of the CV, and text the person had DELETED under tracked
  // changes was being put back into the document an employer receives.
  const src = readFileSync(new URL('../src/ui/resume-read-core.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function xmlToText'), src.indexOf('// ---', src.indexOf('function xmlToText')));

  for (const tag of ['instrText', 'delText']) {
    const at2 = fn.indexOf(tag);
    assert.ok(at2 > 0, `<w:${tag}> is not handled`);
  }
  // Dropped WITH their contents, and before the general strip unwraps them.
  assert.ok(
    fn.indexOf('w:instrText') < fn.indexOf("replace(/<[^>]+>/g, '')"),
    'the general strip runs first, so the contents survive anyway',
  );
  assert.match(fn, /<\\\/w:instrText>/);
});
