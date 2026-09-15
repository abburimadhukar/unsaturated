import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  crc32,
  docxBytes,
  docxFileName,
  documentXml,
  escapeXml,
  looksLikeHeading,
  splitDates,
} from '../src/ui/docx.js';
import { extractResumeText } from '../src/ui/resume-file.js';

/**
 * A .docx written by hand, and read back by the app's own reader.
 *
 * THE TEST THAT MATTERS IS THE ROUND TRIP
 *
 * Everything else here checks a detail. The round trip checks the thing that can
 * actually go wrong: a ZIP whose headers are subtly off, or a deflate stream with
 * two bytes of zlib header on the front, produces a file that LOOKS like a .docx,
 * downloads without complaint, and fails to open. Nothing in a unit test of the XML
 * would notice.
 *
 * So the output is handed to extractResumeText — the same function that reads an
 * uploaded CV in production — and the text has to come back. A writer whose output
 * the reader cannot open is a writer nobody should trust with a job application.
 */

/**
 * Written as a code point rather than an escape.
 *
 * A literal newline has been written into a string literal in this project more
 * than once — it compiles nowhere and is invisible in a diff. There is nothing
 * here to get wrong.
 */
const NL = String.fromCharCode(10);

const RESUME = [
  'Madhukar Abburi',
  'Platform and Data Engineer · London',
  '',
  'EXPERIENCE',
  'Senior Platform Engineer, Acme Corp, 2021 to present',
  'Ran multi-region AWS and Azure infrastructure for the platform team.',
  'Cut deploy time to 12 minutes with Docker and Kubernetes CI/CD pipelines.',
  'Owned the Terraform estate and the Linux fleet.',
  '',
  'TECHNICAL SKILLS',
  'AWS, Azure, Kubernetes, Terraform, Docker, CI/CD, Linux, Python, SQL, dbt',
  '',
  'EDUCATION',
  'BSc Computer Science, 2015 to 2019',
].join('\n');

const asFile = (bytes: Uint8Array, name = 'resume.docx') =>
  new File([bytes as BlobPart], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test('A GENERATED .docx IS READABLE BY THE APP OWN READER', async () => {
  const bytes = await docxBytes(RESUME);
  const read = await extractResumeText(asFile(bytes));

  // The generated document is a full resume, so the reader should have no
  // complaint at all about it. (The assertion used to read `read.error`, which
  // ExtractResult has never had — undefined against undefined.)
  assert.equal(read.warning, null, `the reader refused it: ${read.warning}`);
  const text = read.text;

  // Every WORD of the original has to come back. Not every line byte for byte:
  // an employer line is now split, company at the left margin and dates at the
  // right, so "Acme Corp, 2021 to present" comes back as "Acme Corp" and "2021 to
  // present" with a tab between and the dangling comma gone. That is the layout
  // doing its job — what must never happen is a word going missing.
  const flat = text.replace(/\s+/g, ' ');
  for (const line of RESUME.split(NL).filter((l) => l.trim())) {
    for (const word of line.trim().split(/\s+/)) {
      const bare = word.replace(/[,;]$/, '');
      assert.ok(flat.includes(bare), `"${bare}" did not survive the round trip`);
    }
  }
});

test('AN EMPLOYER LINE IS SPLIT, COMPANY LEFT AND DATES RIGHT', () => {
  // The plain text can only run them together. The document this generator is
  // measured against puts the company at the left margin and the dates at the
  // right, on one line — and a tab stop is the ATS-safe way to do it, because a
  // table is one of the documented ways to have a resume parsed into nonsense.
  const xml = documentXml(RESUME);
  assert.match(xml, /<w:tab w:val="right" w:pos="9638"\/>/, 'no right tab stop');
  assert.match(xml, />Senior Platform Engineer, Acme Corp</);
  assert.match(xml, />2021 to present</);
  assert.ok(!xml.includes('Acme Corp, 2021'), 'the line was left run together');
});

test('splitDates finds the date range and leaves everything else alone', () => {
  assert.deepEqual(splitDates('TCL, United States Aug 2025 - Present'), {
    who: 'TCL, United States',
    when: 'Aug 2025 - Present',
  });
  assert.deepEqual(splitDates('Anna University Aug 2016 – Sep 2020'), {
    who: 'Anna University',
    when: 'Aug 2016 – Sep 2020',
  });
  assert.equal(splitDates('Built the payment service in .NET Core'), null);
  assert.equal(splitDates('TECHNICAL SKILLS'), null);
  // A bare date with nothing in front of it is not a company.
  assert.equal(splitDates('Aug 2016 - Sep 2020'), null);
});

test('A HEADING IS HELD TO WHAT FOLLOWS IT, AND NO PARAGRAPH SPLITS', () => {
  // Without this Word broke wherever it liked: a university on one page and its
  // degree on the next, an employer separated from its first bullet, a third of a
  // page left blank under a heading.
  const xml = documentXml(RESUME);
  const beforeHeading = xml.slice(0, xml.indexOf('>EXPERIENCE<'));
  assert.match(beforeHeading.slice(-400), /<w:keepNext\/>/, 'a heading can still end a page');
  assert.ok((xml.match(/<w:keepLines\/>/g) ?? []).length > 10, 'paragraphs can still split');
});

test('THE SKILLS LABEL IS BOLD AND THE LIST AFTER IT IS NOT', () => {
  // What makes the section skimmable, and the colon is the whole signal.
  const xml = documentXml(
    ['NAME', 'TECHNICAL SKILLS', 'Cloud Technologies: AWS, Azure, Kubernetes'].join(NL),
  );
  const at = xml.indexOf('AWS, Azure, Kubernetes');
  assert.ok(at > 0, 'the skills list is missing');
  const before = xml.slice(0, at);
  // The label is its own bold run, inside the same paragraph as the plain list.
  assert.ok(before.includes('>Cloud Technologies:<'), 'the label is not its own run');
  assert.ok(
    before.lastIndexOf('<w:b/>') > before.lastIndexOf('</w:p>'),
    'the label is not bold',
  );
  // And the list itself is not bold: its run opens after the label's closes.
  const listRun = xml.slice(before.lastIndexOf('<w:r>', at), at);
  assert.ok(!listRun.includes('<w:b/>'), 'the whole line was bolded');
});

test('A SKILLS LINE WITH NO LABEL IS LEFT ALONE', () => {
  // "AWS, Azure, Kubernetes, Terraform, Docker" has no colon, so there is no
  // label to embolden and nothing to split on.
  const xml = documentXml(['NAME', 'TECHNICAL SKILLS', 'AWS, Azure, Docker'].join(NL));
  const at = xml.indexOf('AWS, Azure, Docker');
  const run = xml.slice(xml.lastIndexOf('<w:r>', at), at);
  assert.ok(!run.includes('<w:b/>'), 'a line with no label was bolded');
});

test('bullets are an indented list, not a character inside the sentence', () => {
  const xml = documentXml(['EXPERIENCE', '· Ran the platform.'].join(NL));
  assert.match(xml, /<w:ind w:left="357" w:hanging="357"\/>/);
  assert.match(xml, />Ran the platform\.</);
  assert.ok(!/>· Ran the platform/.test(xml), 'the marker is still inside the sentence');
});

test('WORDS DO NOT RUN TOGETHER, WHICH IS THE FAILURE A PARSER WOULD SEE', async () => {
  // The specific way a generated document is broken while looking fine: adjacent
  // runs with no separation extract as "RanmultiregionAWS". An employer's parser
  // reads that; a human looking at the rendered page does not.
  const bytes = await docxBytes(RESUME);
  const text = (await extractResumeText(asFile(bytes))).text ?? '';
  assert.ok(text.includes('Ran multi-region AWS'), 'spacing was lost between words');
  assert.ok(!/[a-z][A-Z][a-z]{4,}/.test(text.replace(/CI\/CD|BSc|SQL|AWS/g, '')), text.slice(0, 200));
});

test('the compressed stream is raw deflate, not zlib-wrapped', async () => {
  // ZIP method 8 expects bare deflate. Two leading zlib bytes make Word reject the
  // whole file with no useful message — and the round trip above is what catches
  // it, so this asserts the method byte is what it claims.
  const bytes = await docxBytes(RESUME);
  // Local header: method is the 2-byte field at offset 8.
  const method = bytes[8]! | (bytes[9]! << 8);
  assert.ok(method === 8 || method === 0, `unexpected compression method ${method}`);
  if (method === 8) {
    // First entry's data begins after the 30-byte header plus the name.
    const nameLen = bytes[26]! | (bytes[27]! << 8);
    const first = bytes[30 + nameLen]!;
    // A zlib stream starts 0x78; raw deflate's first byte has the low bits of a
    // block header instead and is never 0x78 for these inputs.
    assert.notEqual(first, 0x78, 'the stream carries a zlib header');
  }
});

test('an empty resume still produces a file the reader can open', async () => {
  // It should not happen — the route refuses an empty resume — but producing a
  // corrupt ZIP for it would be a worse answer than producing an empty document.
  const bytes = await docxBytes('');
  assert.ok(bytes.length > 300, 'suspiciously small for a four-part zip');
  const read = await extractResumeText(asFile(bytes));
  // Too short to be a useful resume, so the reader may object on length — what it
  // must not do is fail to UNZIP it.
  assert.ok(!/zip|corrupt|not readable/i.test(read.warning ?? ''), read.warning ?? undefined);
});

// ---------------------------------------------------------------------------
// The ZIP itself
// ---------------------------------------------------------------------------

test('it starts with a local file header and ends with an end-of-directory record', async () => {
  const b = await docxBytes(RESUME);
  assert.deepEqual([...b.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'not a ZIP');
  const tail = b.slice(b.length - 22, b.length - 18);
  assert.deepEqual([...tail], [0x50, 0x4b, 0x05, 0x06], 'no end-of-central-directory');
});

test('the central directory holds one entry per part', async () => {
  const b = await docxBytes(RESUME);
  // Entry count is the 2-byte field 10 bytes into the 22-byte EOCD.
  const eocd = b.length - 22;
  const count = b[eocd + 10]! | (b[eocd + 11]! << 8);
  assert.equal(count, 5, 'expected Content_Types, two rels, styles and document');
});

test('CRC-32 matches the known value for a known string', () => {
  // A wrong CRC is the other way a ZIP opens in one tool and not another. Checked
  // against the standard test vector rather than against itself.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('the same text always produces the same bytes', async () => {
  // No clock in the headers. A timestamp would make every download differ and make
  // any byte-level test impossible to write.
  const a = await docxBytes(RESUME);
  const b = await docxBytes(RESUME);
  assert.deepEqual([...a], [...b]);
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

test('XML-BREAKING CHARACTERS IN A CV ARE ESCAPED', () => {
  // "R&D", "C++ & Java", a quoted job title. Unescaped, the ampersand alone makes
  // Word refuse the document.
  const xml = documentXml('Led R&D on <C++> & "Java"');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), 'a bare ampersand survived');
  assert.ok(xml.includes('&amp;'));
  assert.ok(xml.includes('&lt;C++&gt;'));
});

test('a control character from a pasted CV is removed rather than breaking the file', () => {
  // Not valid in XML 1.0 at any escape, so Word rejects the whole document. Pasted
  // text from a PDF carries them routinely.
  const out = escapeXml(`clean${String.fromCharCode(7)}text`);
  assert.equal(out, 'cleantext');
});

test('blank lines survive as blank paragraphs', () => {
  // A resume's structure is carried by its blank lines. Dropping them turns a
  // document into one block of prose.
  const xml = documentXml('One\n\nTwo');
  const paragraphs = xml.match(/<w:p>/g) ?? [];
  assert.equal(paragraphs.length, 3, 'the blank line was dropped');
});

test('leading indentation is preserved on an ordinary line', () => {
  // Without xml:space="preserve" Word eats it, and an indented sub-bullet becomes
  // a top-level one. Checked on a body line: the name, the headings and the
  // employer lines are trimmed deliberately, because indentation in front of a
  // centred name is not indentation, it is a stray space.
  const doc = ['NAME', '', '  indented'].join(NL);
  assert.match(documentXml(doc), /xml:space="preserve">  indented</);
});

test('section headings are recognised by shape, not by vocabulary', () => {
  for (const yes of ['EXPERIENCE', 'TECHNICAL SKILLS', 'EDUCATION']) {
    assert.equal(looksLikeHeading(yes), true, `${yes} should be a heading`);
  }
  for (const no of [
    'Managed AWS and Azure infrastructure',
    'AWS, Azure, Kubernetes, Terraform, Docker, CI/CD, Linux, Python',
    'Ran the fleet.',
    '',
    '-----',
    '2021 to present',
  ]) {
    assert.equal(looksLikeHeading(no), false, `"${no}" should not be a heading`);
  }
});

test('the name line and the headings are bold, the bullets are not', () => {
  const xml = documentXml(RESUME);
  const nameAt = xml.indexOf('Madhukar Abburi');
  const bulletAt = xml.indexOf('Ran multi-region');
  // The bold marker belongs to the paragraph it precedes, so compare how far back
  // the nearest one sits.
  const boldBefore = (at: number) => at - xml.lastIndexOf('<w:b/>', at);
  assert.ok(boldBefore(nameAt) < 200, 'the name is not bold');
  assert.ok(boldBefore(bulletAt) > 200, 'a bullet was made bold');
});

test('A4 page size and margins are declared', () => {
  // Word opens a document without them but reflows it unpredictably, so the thing
  // a person previewed is not the thing an employer receives.
  const xml = documentXml(RESUME);
  assert.match(xml, /<w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.match(xml, /w:pgMar/);
});

test('NO TABLES, TEXT BOXES, HEADERS OR IMAGES ARE EMITTED', () => {
  // Each one is a documented way to have a resume parsed into nonsense. The source
  // is plain lines, so there is no reason for any of them to appear — this is here
  // so a later "nicer layout" change has to argue with a test.
  const xml = documentXml(RESUME);
  for (const bad of ['<w:tbl', 'w:txbxContent', '<w:hdr', '<w:ftr', 'w:drawing', '<w:sectPr><w:cols']) {
    assert.ok(!xml.includes(bad), `${bad} is not ATS-safe`);
  }
});

// ---------------------------------------------------------------------------
// The file name
// ---------------------------------------------------------------------------

test('the file name carries the job title', () => {
  // Six tailored resumes in one folder, and "resume.docx (3)" says nothing.
  assert.equal(docxFileName('Senior Platform Engineer'), 'resume-senior-platform-engineer.docx');
});

test('a hostile or empty job title still gives a usable name', () => {
  assert.equal(docxFileName('../../etc/passwd'), 'resume-etc-passwd.docx');
  assert.equal(docxFileName(''), 'resume.docx');
  assert.equal(docxFileName('!!!'), 'resume.docx');
  assert.ok(docxFileName('x'.repeat(200)).length < 70, 'the name is unusably long');
  for (const name of [docxFileName('a/b\\c:d'), docxFileName('a\nb')]) {
    assert.ok(!/[\\/:\n]/.test(name), `path characters survived: ${name}`);
  }
});
