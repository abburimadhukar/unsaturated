import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { extractResumeText, isAcceptedFile } from '../src/ui/resume-file.js';
import { extractSkills } from '../src/taxonomy/families.js';

/**
 * Does a resume file actually turn into text?
 *
 * tests/resume-file.test.ts covers the RULES around the upload — signed-in only,
 * the filename never becomes a path, the bucket stays private. None of it reads
 * a file. So the extraction itself, which is the only reason the upload exists,
 * had no test at all.
 *
 * That matters more than it looks. Every match score depends on this text: no
 * text, no skills, no score. And the path has never successfully run in
 * production — the three accounts on record all show `has_file: false`, because
 * uploads failed outright until the null-timestamp bug was fixed in ebdcf59 and
 * nobody has tried since.
 *
 * So these build real files and run the real extractor.
 */

/** A .docx is a ZIP holding word/document.xml. Built here to a real spec. */
function docxWith(documentXml: string, { store = false } = {}): Uint8Array {
  const name = new TextEncoder().encode('word/document.xml');
  const raw = new TextEncoder().encode(documentXml);
  const body = store ? raw : new Uint8Array(deflateRawSync(raw));
  const method = store ? 0 : 8;

  const local = new Uint8Array(30 + name.length + body.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, method, true);
  lv.setUint32(18, body.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, name.length, true);
  lv.setUint16(28, 0, true);
  local.set(name, 30);
  local.set(body, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, method, true);
  cv.setUint32(20, body.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint16(30, 0, true);
  cv.setUint16(32, 0, true);
  cv.setUint32(42, 0, true);
  central.set(name, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

/** A plausible resume, as Word would store it. */
const RESUME_XML =
  '<?xml version="1.0"?><w:document><w:body>' +
  para('Jaswanth Malineni') +
  para('Senior Data Engineer') +
  para('Skills') +
  para('Python, AWS, Airflow, dbt, Snowflake, Terraform, Kubernetes') +
  para('Experience') +
  para('Built ETL pipelines for billing data, cutting warehouse cost by 40%.') +
  para('Owned Airflow DAGs in production and mentored three junior engineers.') +
  '</w:body></w:document>';

const asFile = (bytes: Uint8Array, name: string) =>
  new File([bytes as unknown as BlobPart], name);

// ---------------------------------------------------------------------------
// DOCX — the format the tailoring feature will need to edit in place
// ---------------------------------------------------------------------------

test('A REAL DOCX BECOMES READABLE TEXT', async () => {
  const { text, warning } = await extractResumeText(asFile(docxWith(RESUME_XML), 'cv.docx'));
  assert.equal(warning, null, 'a readable resume produces no warning');
  assert.match(text, /Jaswanth Malineni/);
  assert.match(text, /Senior Data Engineer/);
  assert.match(text, /Airflow/);
  assert.match(text, /cutting warehouse cost by 40%/);
});

test('headings do not run into the line after them', async () => {
  // The bug the xmlToText comment is about: strip the tags first and
  // "Skills" + "Python" become "SkillsPython", which the matcher never sees.
  const { text } = await extractResumeText(asFile(docxWith(RESUME_XML), 'cv.docx'));
  assert.doesNotMatch(text, /SkillsPython/);
  assert.doesNotMatch(text, /EngineerSkills/);
  assert.match(text, /Skills\s+Python/);
});

test('THE EXTRACTED TEXT ACTUALLY FEEDS THE SKILL MATCHER', async () => {
  // The whole point. Text that no skill fires on is the same as no text.
  const { text } = await extractResumeText(asFile(docxWith(RESUME_XML), 'cv.docx'));
  const skills = extractSkills(text);
  assert.ok(skills.length >= 4, `expected several skills, got ${skills.length}: ${skills}`);
  for (const expected of ['python', 'aws']) {
    assert.ok(
      skills.some((s) => s.toLowerCase().includes(expected)),
      `expected ${expected} among ${skills.join(', ')}`,
    );
  }
});

test('an uncompressed docx is read too', async () => {
  // Method 0 — stored rather than deflated. Rare, legal, and a branch in the
  // reader that would otherwise never be exercised.
  const { text } = await extractResumeText(
    asFile(docxWith(RESUME_XML, { store: true }), 'cv.docx'),
  );
  assert.match(text, /Jaswanth Malineni/);
});

test('Word entities come back as the characters they stand for', async () => {
  const xml =
    '<?xml version="1.0"?><w:document><w:body>' +
    para('R&amp;D at Smith &amp; Co') +
    para('&quot;Lead&quot; &lt;not&gt; manager &apos;acting&apos;') +
    '</w:body></w:document>';
  const { text } = await extractResumeText(asFile(docxWith(xml), 'cv.docx'));
  assert.match(text, /R&D at Smith & Co/);
  assert.match(text, /"Lead" <not> manager 'acting'/);
});

test('a line break inside a paragraph still separates words', async () => {
  const xml =
    '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>AWS</w:t><w:br/><w:t>Terraform</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  const { text } = await extractResumeText(asFile(docxWith(xml), 'cv.docx'));
  assert.doesNotMatch(text, /AWSTerraform/);
});

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

test('txt and md are read straight through', async () => {
  // Over 200 characters on purpose. Below that the extractor warns that the
  // text is too thin to score on, which is correct — my first version of this
  // test used a 48-character sample and failed for that reason, not a bug.
  const body =
    'Jaswanth Malineni\nSenior Data Engineer\n\n' +
    'Skills: Python, AWS, Kafka, Spark, Airflow, dbt, Snowflake, Terraform, Kubernetes\n\n' +
    'Experience\nBuilt ETL pipelines for billing data, cutting warehouse cost by 40%.\n' +
    'Owned Airflow DAGs in production and mentored three junior engineers.\n';
  assert.ok(body.length > 200, 'the sample must be a plausible resume length');

  for (const name of ['cv.txt', 'cv.md']) {
    const { text, warning } = await extractResumeText(
      new File([body], name, { type: 'text/plain' }),
    );
    assert.equal(warning, null, name);
    assert.match(text, /Kafka/, name);
    assert.ok(extractSkills(text).length >= 4, name);
  }
});

// ---------------------------------------------------------------------------
// The honest failures — a lost upload is worse than a warning
// ---------------------------------------------------------------------------

test('A SCANNED PDF IS A WARNING, NOT A LOST UPLOAD', async () => {
  // Someone photographing their CV is a real thing. The file must still be
  // stored and the person told plainly, not shown an error.
  const notReallyAPdf = new TextEncoder().encode('%PDF-1.4 no text layer here');
  const { text, warning } = await extractResumeText(asFile(notReallyAPdf, 'scan.pdf'));
  assert.equal(text, '', 'no text came out');
  assert.ok(warning, 'but the person is told why');
  assert.doesNotMatch(warning!, /undefined|\[object/, 'and told in English');
});

test('a corrupt docx warns rather than throwing', async () => {
  const junk = new TextEncoder().encode('this is not a zip at all');
  const { text, warning } = await extractResumeText(asFile(junk, 'cv.docx'));
  assert.equal(text, '');
  assert.ok(warning);
});

test('an empty file does not pretend to have worked', async () => {
  const { text, warning } = await extractResumeText(new File([''], 'cv.txt'));
  assert.equal(text, '');
  assert.ok(warning, 'an empty resume is worth saying out loud');
});

test('a thin resume is flagged, because the score would be meaningless', async () => {
  const { text, warning } = await extractResumeText(new File(['Python'], 'cv.txt'));
  assert.ok(text.length < 200);
  assert.ok(warning, 'six characters is not a resume');
});

test('an oversized file is refused before it is parsed', async () => {
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  const { text, warning } = await extractResumeText(asFile(big, 'cv.pdf'));
  assert.equal(text, '');
  assert.match(warning ?? '', /5 MB/);
});

test('an old .doc says what to do instead', async () => {
  const { warning } = await extractResumeText(new File(['x'], 'cv.doc'));
  assert.match(warning ?? '', /\.docx|PDF|paste/i);
});

test('an unsupported type is named, not silently dropped', async () => {
  const { text, warning } = await extractResumeText(new File(['x'], 'cv.pages'));
  assert.equal(text, '');
  assert.ok(warning);
  assert.equal(isAcceptedFile('cv.pages'), false);
  for (const ok of ['cv.pdf', 'CV.DOCX', 'cv.txt', 'notes.md']) {
    assert.equal(isAcceptedFile(ok), true, ok);
  }
});

test('control characters do not survive into the stored text', async () => {
  const xml =
    '<?xml version="1.0"?><w:document><w:body>' +
    para('AWS' + String.fromCharCode(0) + 'Python' + String.fromCharCode(8) + 'Kafka') +
    '</w:body></w:document>';
  const { text } = await extractResumeText(asFile(docxWith(xml), 'cv.docx'));
  for (const code of [0, 8, 27]) {
    assert.ok(!text.includes(String.fromCharCode(code)), `code ${code} must be gone`);
  }
});
