import { test } from 'node:test';
import assert from 'node:assert/strict';

import { docxBytes } from '../src/ui/docx.js';
import { editDocx, flatten, readZip, rezipWith, textNodes } from '../src/ui/docx-edit.js';
import { extractResumeText } from '../src/ui/resume-file.js';

/**
 * Editing somebody's own .docx without rebuilding it.
 *
 * The failures here are the expensive kind. A document that will not open, an
 * embedded font quietly corrupted, a bullet replaced in the wrong place, a
 * replacement spliced through the middle of "&amp;" so Word refuses the file. All
 * of those produce something that downloads cleanly and fails later, in front of
 * an employer.
 *
 * So the tests mostly assert on the document AFTER a round trip through readZip
 * and through extractResumeText — the same reader the upload path uses.
 */

/** A .docx whose text is split across runs the way Word actually splits it. */
async function splitRunDocx(): Promise<Uint8Array> {
  const base = await docxBytes('placeholder');
  const entries = readZip(base);
  const docIndex = entries.findIndex((e) => e.name === 'word/document.xml');

  // Three runs forming one sentence, split mid-word, with the last run bold —
  // exactly what a CV edited over several sessions looks like inside.
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t xml:space="preserve">Managed cloud infra</w:t></w:r>' +
    '<w:r><w:t xml:space="preserve">structure for the </w:t></w:r>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t>platform team</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Owned R&amp;D on the Linux fleet</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Wrote Python and SQL for the warehouse</w:t></w:r></w:p>' +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
    '</w:body></w:document>';

  return rezipWith(entries, docIndex, new TextEncoder().encode(xml));
}

const textOf = async (bytes: Uint8Array): Promise<string> => {
  const file = new File([bytes as BlobPart], 'resume.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const read = await extractResumeText(file);
  assert.equal(read.error, undefined, `the reader refused the edited file: ${read.error}`);
  return read.text ?? '';
};

// ---------------------------------------------------------------------------
// The hard case: one sentence, several runs
// ---------------------------------------------------------------------------

test('A SENTENCE SPLIT ACROSS THREE RUNS IS FOUND AND REPLACED', async () => {
  // The whole reason this file is not a string replace. Word splits runs at every
  // formatting boundary and at nothing in particular, so searching any single
  // <w:t> for the sentence finds nothing — and a naive implementation reports the
  // edit as "not in your resume" for a line that is plainly there.
  const original = await splitRunDocx();
  const res = await editDocx(original, [
    {
      original: 'Managed cloud infrastructure for the platform team',
      replacement: 'Ran multi-region AWS infrastructure for the platform team',
    },
  ]);

  assert.equal(res.applied, 1, `not applied; missed: ${JSON.stringify(res.missed)}`);
  const text = await textOf(res.bytes);
  assert.ok(text.includes('Ran multi-region AWS infrastructure for the platform team'));
  assert.ok(!text.includes('Managed cloud infrastructure'), 'the old text is still there');
});

test('the other paragraphs are untouched', async () => {
  const res = await editDocx(await splitRunDocx(), [
    { original: 'Managed cloud infrastructure for the platform team', replacement: 'Ran AWS' },
  ]);
  const text = await textOf(res.bytes);
  assert.ok(text.includes('Owned R&D on the Linux fleet'), 'an unrelated line changed');
  assert.ok(text.includes('Wrote Python and SQL for the warehouse'));
});

test('AN AMPERSAND IN THE DOCUMENT DOES NOT BREAK THE OFFSET ARITHMETIC', async () => {
  // "&amp;" is five characters of XML for one character of text. Using a text
  // offset against the raw string slices through the middle of the entity and
  // produces malformed XML — a document Word refuses, from a CV that merely
  // mentioned R&D. The reader below would fail to parse it.
  const res = await editDocx(await splitRunDocx(), [
    { original: 'Owned R&D on the Linux fleet', replacement: 'Ran R&D across the Linux fleet' },
  ]);
  assert.equal(res.applied, 1, JSON.stringify(res.missed));
  const text = await textOf(res.bytes);
  assert.ok(text.includes('Ran R&D across the Linux fleet'), text.slice(0, 200));
});

test('AN ENTITY BEFORE THE MATCH SHIFTS THE RAW OFFSET, AND MUST BE ACCOUNTED FOR', async () => {
  // The previous test has the match starting at offset 0, so the text kept BEFORE
  // it is empty and a wrong offset costs nothing — a mutation using the unescaped
  // offset directly passed it. Here "R&D team: " sits in front, so "&amp;" makes
  // the raw index four characters further along than the text index. Get it wrong
  // and the kept prefix is cut through the middle of the entity, producing XML
  // Word refuses.
  const base = await docxBytes('placeholder');
  const entries = readZip(base);
  const docIndex = entries.findIndex((e) => e.name === 'word/document.xml');
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>R&amp;D team: Managed the cloud estate</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const doc = await rezipWith(entries, docIndex, new TextEncoder().encode(xml));

  const res = await editDocx(doc, [
    { original: 'Managed the cloud estate', replacement: 'Ran the cloud estate' },
  ]);
  assert.equal(res.applied, 1, JSON.stringify(res.missed));

  const text = await textOf(res.bytes);
  assert.ok(text.includes('R&D team: Ran the cloud estate'), `prefix was damaged: ${text}`);
});

test('an entity AFTER the match is kept intact too', async () => {
  const base = await docxBytes('placeholder');
  const entries = readZip(base);
  const docIndex = entries.findIndex((e) => e.name === 'word/document.xml');
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>Managed the cloud estate for R&amp;D</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const doc = await rezipWith(entries, docIndex, new TextEncoder().encode(xml));

  const res = await editDocx(doc, [
    { original: 'Managed the cloud estate', replacement: 'Ran the cloud estate' },
  ]);
  assert.equal(res.applied, 1, JSON.stringify(res.missed));
  const text = await textOf(res.bytes);
  assert.ok(text.includes('Ran the cloud estate for R&D'), `suffix was damaged: ${text}`);
});

test('AN ENTITY INSIDE THE MATCH SHIFTS THE END OFFSET TOO', async () => {
  // The third and last place the escaped/unescaped distinction bites, and the one
  // the two tests above do not reach: an entity WITHIN the replaced span, with text
  // after it in the same run. A mutation using the raw end offset directly passed
  // both of them, and corrupts the kept suffix here.
  const base = await docxBytes('placeholder');
  const entries = readZip(base);
  const docIndex = entries.findIndex((e) => e.name === 'word/document.xml');
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t xml:space="preserve">Owned R&amp;D tooling. Mentored two juniors.</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const doc = await rezipWith(entries, docIndex, new TextEncoder().encode(xml));

  const res = await editDocx(doc, [
    { original: 'Owned R&D tooling.', replacement: 'Ran the R&D toolchain.' },
  ]);
  assert.equal(res.applied, 1, JSON.stringify(res.missed));

  // EXACT, not `includes`. A wrong end offset leaves a fragment of the old text
  // behind -- "Ran the R&D toolchain.ing. Mentored two juniors." -- and both halves
  // of an `includes` pair still match that, which is how the mutation survived two
  // earlier attempts at this test.
  const text = (await textOf(res.bytes)).replace(/\s+/g, ' ').trim();
  assert.equal(text, 'Ran the R&D toolchain. Mentored two juniors.');
});

test('a replacement containing an ampersand is escaped on the way in', async () => {
  const res = await editDocx(await splitRunDocx(), [
    {
      original: 'Wrote Python and SQL for the warehouse',
      replacement: 'Wrote Python & SQL for the <warehouse>',
    },
  ]);
  assert.equal(res.applied, 1);
  const text = await textOf(res.bytes);
  assert.ok(text.includes('Wrote Python & SQL for the <warehouse>'), text.slice(0, 200));
});

test('several edits all land', async () => {
  const res = await editDocx(await splitRunDocx(), [
    { original: 'Managed cloud infrastructure for the platform team', replacement: 'Ran AWS estate' },
    { original: 'Wrote Python and SQL for the warehouse', replacement: 'Built the warehouse in dbt' },
  ]);
  assert.equal(res.applied, 2, JSON.stringify(res.missed));
  const text = await textOf(res.bytes);
  assert.ok(text.includes('Ran AWS estate'));
  assert.ok(text.includes('Built the warehouse in dbt'));
});

test('EDITS ARE APPLIED ONE AT A TIME, SO EARLIER ONES DO NOT MISPLACE LATER ONES', async () => {
  // Every replacement moves the offsets of everything after it. Computing all the
  // positions once and then splicing would write the second edit at a stale index
  // — into the middle of a word, or into a tag.
  const res = await editDocx(await splitRunDocx(), [
    {
      original: 'Managed cloud infrastructure for the platform team',
      // Much longer, so every later offset shifts a long way.
      replacement:
        'Ran multi-region AWS and Azure infrastructure for the whole platform engineering team',
    },
    { original: 'Wrote Python and SQL for the warehouse', replacement: 'Built it in dbt' },
  ]);
  assert.equal(res.applied, 2, JSON.stringify(res.missed));
  const text = await textOf(res.bytes);
  assert.ok(text.includes('platform engineering team'));
  assert.ok(text.includes('Built it in dbt'), 'the second edit landed in the wrong place');
});

// ---------------------------------------------------------------------------
// What must survive untouched
// ---------------------------------------------------------------------------

test('EVERY OTHER ENTRY COMES BACK BYTE FOR BYTE', async () => {
  // The reason unchanged entries are copied as their already-compressed bytes
  // rather than decompressed and re-deflated: a CV carries embedded fonts, a
  // headshot, a theme. Re-compressing them risks nothing visible going wrong and
  // everything being subtly different, and there is no reason to touch them.
  const original = await splitRunDocx();
  const res = await editDocx(original, [
    { original: 'Wrote Python and SQL for the warehouse', replacement: 'Built it in dbt' },
  ]);

  const before = readZip(original);
  const after = readZip(res.bytes);
  assert.equal(after.length, before.length, 'an entry was added or lost');

  for (const b of before) {
    const a = after.find((e) => e.name === b.name);
    assert.ok(a, `${b.name} is missing from the edited file`);
    if (b.name === 'word/document.xml') continue;
    assert.equal(a.crc, b.crc, `${b.name} changed`);
    assert.equal(a.uncompressedSize, b.uncompressedSize, `${b.name} changed size`);
    assert.deepEqual([...a.data], [...b.data], `${b.name} was re-compressed`);
  }
});

test('the bold run in the middle of an edited paragraph keeps its own formatting', async () => {
  // The replacement inherits the formatting of the FIRST run it lands in, and the
  // runs it did not touch keep theirs. A documented limitation rather than a bug —
  // see the header — so this pins the behaviour rather than claiming it is ideal.
  const res = await editDocx(await splitRunDocx(), [
    { original: 'Wrote Python and SQL for the warehouse', replacement: 'Built it in dbt' },
  ]);
  const entries = readZip(res.bytes);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  assert.ok(doc);
  // The bold marker on the untouched paragraph is still in the document.
  const xml = await (async () => {
    const stream = new Blob([doc.data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  })();
  assert.ok(xml.includes('<w:b/>'), 'the bold run lost its formatting');
  assert.ok(xml.includes('<w:sectPr>'), 'the section properties were dropped');
});

// ---------------------------------------------------------------------------
// When it cannot be done
// ---------------------------------------------------------------------------

test('AN EDIT WHOSE TEXT IS NOT IN THE DOCUMENT IS REPORTED, NOT GUESSED AT', async () => {
  const res = await editDocx(await splitRunDocx(), [
    { original: 'A line from somebody else resume', replacement: 'Improved somehow' },
  ]);
  assert.equal(res.applied, 0);
  assert.equal(res.missed.length, 1);
  const text = await textOf(res.bytes);
  assert.ok(text.includes('Managed cloud infrastructure'), 'the document was altered anyway');
});

test('a mix of found and missing edits applies what it can and says what it could not', async () => {
  const res = await editDocx(await splitRunDocx(), [
    { original: 'Wrote Python and SQL for the warehouse', replacement: 'Built it in dbt' },
    { original: 'Not present anywhere', replacement: 'x' },
  ]);
  assert.equal(res.applied, 1);
  assert.equal(res.missed.length, 1);
});

test('something that is not a .docx gives a clear error rather than a crash', async () => {
  await assert.rejects(
    () => editDocx(new TextEncoder().encode('this is a plain text file'), []),
    /not a \.docx/,
  );
});

test('a zip with no document.xml is refused by name', async () => {
  const entries = readZip(await docxBytes('hello world this is a resume'));
  const withoutDoc = entries.filter((e) => e.name !== 'word/document.xml');
  const bytes = await rezipWith(withoutDoc, -1, new Uint8Array(0));
  await assert.rejects(() => editDocx(bytes, []), /no word\/document\.xml/);
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

test('text nodes are found in document order', () => {
  const nodes = textNodes('<w:t>one</w:t><w:t xml:space="preserve"> two</w:t><w:t>three</w:t>');
  assert.deepEqual(nodes.map((n) => n.text), ['one', ' two', 'three']);
});

test('an empty text element does not break the scan', () => {
  const nodes = textNodes('<w:t></w:t><w:t>after</w:t>');
  assert.deepEqual(nodes.map((n) => n.text), ['', 'after']);
});

test('flattening collapses whitespace and maps every character back', () => {
  // Matching on the raw run text would fail on a line split across a newline in
  // the XML, which is most of them.
  const nodes = textNodes('<w:t>Ran   the</w:t><w:t>\n  fleet</w:t>');
  const flat = flatten(nodes);
  assert.equal(flat.text, 'Ran the fleet');
  assert.equal(flat.map.length, flat.text.length, 'the map must cover every character');
  // The final character belongs to the second node.
  assert.equal(flat.map[flat.map.length - 1]!.node, 1);
});

test('the offsets point at the right node for a split word', () => {
  const nodes = textNodes('<w:t>infra</w:t><w:t>structure</w:t>');
  const flat = flatten(nodes);
  assert.equal(flat.text, 'infrastructure');
  assert.equal(flat.map[0]!.node, 0);
  assert.equal(flat.map[5]!.node, 1, 'the split point is in the wrong node');
});
