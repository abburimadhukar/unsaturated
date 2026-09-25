/**
 * Writing a .docx, with no library.
 *
 * WHY THIS OUTLIVED RESUME TAILORING
 *
 * It was written to export a tailored resume, and tailoring was removed on
 * 25 Sep 2026. It stays because scripts/extension-resume-e2e.mjs uses it to
 * build the sample Word resume that checks the browser extension can import a
 * .docx — and docx.test.ts reads its output back through resume-file.ts, the
 * same reader the Account page uploads with. Nothing on the site calls it now.
 *
 * The mirror of what resume-file.ts already does. That reads a .docx by unzipping
 * it by hand, because the browser ships an inflater in DecompressionStream and the
 * only entry needed is one known name. This writes one by hand for the same
 * reason: the browser ships a deflater in CompressionStream, and a .docx is a ZIP
 * of four small XML files.
 *
 * WHY .docx AND NOT A HAND-ROLLED PDF
 *
 * A PDF written by hand is also possible, and it is the worse of the two here. Its
 * text layer has to be constructed explicitly, and getting the spacing wrong
 * produces a document that LOOKS correct and extracts as "Ranmulti-regionAWS" —
 * which is precisely the failure that matters, because the first reader of a
 * resume is usually a parser. A .docx carries its text as text, so there is
 * nothing to get wrong in that direction.
 *
 * For a PDF the browser's own print-to-PDF is better than anything this file could
 * produce: it handles fonts, kerning and the text layer properly. The page offers
 * that instead.
 *
 * WHAT ATS SAFETY MEANS, CONCRETELY
 *
 * No tables, no text boxes, no headers or footers, no columns, no images. Every
 * one of those is a documented way to have a resume parsed into nonsense or not at
 * all. What comes out of here is a single run of ordinary paragraphs — which is
 * also all the source text can express, since it arrived as lines.
 */

/** The default body size, in half-points as Word counts them. 22 = 11pt. */
const BODY_HALF_POINTS = 22;
/** The name line. 32 = 16pt. */
const NAME_HALF_POINTS = 32;
/** A section heading. 24 = 12pt. */
const HEADING_HALF_POINTS = 24;

import { layoutResume } from './resume-layout.js';

export { looksLikeHeading, splitDates } from './resume-layout.js';

/** XML text content, escaped. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are not valid in XML 1.0 at all and Word refuses the
    // whole file rather than skipping them. A pasted CV can easily carry one.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * A resume's shape, recovered from plain text.
 *
 * WHY THIS EXISTS
 *
 * The first version emitted every line as one flat paragraph — bold if it looked
 * like a heading, plain otherwise. Put beside the document it came from, every
 * difference traced to that:
 *
 *   the name sat left and black, not centred and coloured
 *   "Programming Languages and Scripting:" lost the bold on its label
 *   "TCL, United States Aug 2025 - Present" ran together on one line, where the
 *     original has the company left and the dates right
 *   the role line lost its italic
 *   bullets were the literal character "·", not an indented list
 *   section headings had no rule under them
 *
 * and worst, with no keep-together properties Word broke wherever it liked: a
 * university on one page and its degree on the next, employers split from their
 * first bullet, a third of a page left blank.
 *
 * The text is all there is to work from, so the structure is read back out of it.
 * Every rule below is shape, not vocabulary, so it holds for a CV from any field.
 */

/** Page width less both margins, in twips: 11906 - 1134 - 1134. */
const TEXT_WIDTH = 9638;
/** The heading colour, and the rule under it. Word's Dark Blue, Text 2, Darker 50%. */
const ACCENT = '1F3864';
const CONTACT_GREY = '444444';

interface Look {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  center?: boolean;
  /** Twips before and after the paragraph. */
  before?: number;
  after?: number;
  /** A rule under the paragraph, as section headings have. */
  rule?: boolean;
  /** Hold this paragraph with the next one, so a heading cannot end a page. */
  keepNext?: boolean;
  /** Hanging indent, for a bullet. */
  bullet?: boolean;
  /** Right-aligned second half, for the dates beside an employer. */
  right?: string;
}

/**
 * The typeface, on EVERY run and not only in docDefaults.
 *
 * Reported as "the font is changing". docDefaults sets Calibri, but a run with no
 * rFonts of its own inherits from the document theme, and recent Word ships a
 * different theme font — so the document opened in something else entirely on the
 * machine it mattered on. Naming the font on each run leaves nothing to inherit.
 */
const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';

function runProps(l: Look): string {
  const sz = l.size ?? BODY_HALF_POINTS;
  return (
    FONT +
    (l.bold ? '<w:b/><w:bCs/>' : '') +
    (l.italic ? '<w:i/><w:iCs/>' : '') +
    (l.color ? `<w:color w:val="${l.color}"/>` : '') +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`
  );
}

function run(text: string, l: Look): string {
  return `<w:r><w:rPr>${runProps(l)}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/**
 * One paragraph.
 *
 * `keepLines` is on everywhere: a bullet split across a page break is the single
 * ugliest thing a generated resume does, and no paragraph here is long enough for
 * keeping it whole to cost anything.
 */
function para(text: string, l: Look = {}): string {
  const pPr =
    '<w:pPr>' +
    '<w:keepLines/>' +
    (l.keepNext ? '<w:keepNext/>' : '') +
    (l.center ? '<w:jc w:val="center"/>' : '') +
    (l.bullet ? '<w:ind w:left="357" w:hanging="357"/>' : '') +
    (l.right ? `<w:tabs><w:tab w:val="right" w:pos="${TEXT_WIDTH}"/></w:tabs>` : '') +
    (l.rule
      ? `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="${ACCENT}"/></w:pBdr>`
      : '') +
    `<w:spacing w:before="${l.before ?? 0}" w:after="${l.after ?? 40}" ` +
    'w:line="264" w:lineRule="auto"/>' +
    `<w:rPr>${runProps(l)}</w:rPr>` +
    '</w:pPr>';

  if (text.length === 0 && !l.right) return `<w:p>${pPr}</w:p>`;

  const body = l.bullet
    ? run('•', l) + `<w:r><w:rPr>${runProps(l)}</w:rPr><w:tab/></w:r>` + run(text, l)
    : run(text, l);
  // The dates, pushed to the right margin by a single tab. A tab stop rather than
  // a table, because a table is one of the documented ways to have a resume
  // parsed into nonsense.
  const tail = l.right
    ? `<w:r><w:rPr>${runProps({ size: l.size })}</w:rPr><w:tab/></w:r>` +
      run(l.right, { size: l.size })
    : '';
  return `<w:p>${pPr}${body}${tail}</w:p>`;
}

/** Kept for the tests that assert the simple case, and for anything plain. */
function paragraph(text: string, halfPoints: number, bold: boolean): string {
  return para(text, { size: halfPoints, bold });
}

/**
 * The document body.
 *
 * Every decision about what a line IS was made in resume-layout.ts, which the
 * print view reads too — so the .docx and the PDF cannot disagree about a resume.
 * All that is left here is turning each kind into Word's XML.
 */
export function documentXml(resumeText: string): string {
  const out = layoutResume(resumeText).map((l) => {
    switch (l.kind) {
      case 'blank':
        return para('', { size: 12 });
      case 'name':
        return para(l.text, {
          size: NAME_HALF_POINTS,
          bold: true,
          color: ACCENT,
          center: true,
          after: 20,
        });
      case 'contact':
        return para(l.text, { size: 19, color: CONTACT_GREY, center: true, after: 120 });
      case 'heading':
        // keepNext, so a heading can never be the last thing on a page.
        return para(l.text, {
          size: HEADING_HALF_POINTS,
          bold: true,
          color: ACCENT,
          rule: true,
          before: 200,
          after: 80,
          keepNext: true,
        });
      case 'employer':
        return para(l.text, {
          bold: true,
          right: l.when ?? '',
          before: 120,
          after: 0,
          keepNext: true,
        });
      case 'role':
        return para(l.text, { italic: true, after: 60, keepNext: true });
      case 'bullet':
        return para(l.text, { bullet: true });
      case 'skill':
        return (
          '<w:p><w:pPr><w:keepLines/><w:spacing w:before="0" w:after="40" w:line="264" ' +
          `w:lineRule="auto"/><w:rPr>${runProps({})}</w:rPr></w:pPr>` +
          run(l.label ?? '', { bold: true }) +
          run(l.rest ?? '', {}) +
          '</w:p>'
        );
      default:
        return para(l.text, {});
    }
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${out.join('')}` +
    // Section properties: A4, 2cm margins in twentieths of a point. Required —
    // Word will open a document without them but reflows it unpredictably.
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" ' +
    'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>'
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

/**
 * Minimal styles.
 *
 * One default font for the whole document. Calibri because it is what Word
 * already has and substitutes predictably everywhere else; a font nobody has is
 * how a document arrives looking like something else entirely.
 */
/** The styles part, exported so a test can assert what a document inherits. */
export const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  `<w:sz w:val="${BODY_HALF_POINTS}"/><w:szCs w:val="${BODY_HALF_POINTS}"/>` +
  '</w:rPr></w:rPrDefault>' +
  // 4pt after each paragraph and single line spacing, so the lines of a CV read
  // as a list rather than as one block.
  '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults>' +
  // An explicit Normal style, naming the font again.
  //
  // Word applies Normal to every paragraph, and a Normal that inherits from the
  // document theme picks up whatever that theme's font is — recent Word ships one
  // that is not Calibri. Between this and the rFonts on every run there is
  // nothing left for a theme to override.
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/><w:qFormat/>' +
  `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>` +
  `<w:sz w:val="${BODY_HALF_POINTS}"/><w:szCs w:val="${BODY_HALF_POINTS}"/></w:rPr>` +
  '</w:style>' +
  '</w:styles>';

// ---------------------------------------------------------------------------
// The ZIP
// ---------------------------------------------------------------------------

/** CRC-32, which every ZIP entry header has to carry. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Raw deflate, via the browser's own compressor.
 *
 * 'deflate-raw' and not 'deflate': ZIP method 8 expects the bare deflate stream
 * with no zlib header, and the two differ by two leading bytes. Word rejects the
 * file outright if they are there, which is a failure with no useful message.
 *
 * Falls back to storing the bytes uncompressed where CompressionStream is absent.
 * A stored entry is a perfectly valid ZIP entry — the file is simply larger, and a
 * resume is a few kilobytes either way.
 */
async function deflateRaw(bytes: Uint8Array): Promise<{ data: Uint8Array; method: number }> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return { data: bytes, method: 0 };
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    return { data: new Uint8Array(buf), method: 8 };
  } catch {
    return { data: bytes, method: 0 };
  }
}

interface Entry {
  name: string;
  body: string;
}

/** The four parts of the smallest valid .docx. */
function parts(resumeText: string): Entry[] {
  return [
    { name: '[Content_Types].xml', body: CONTENT_TYPES },
    { name: '_rels/.rels', body: ROOT_RELS },
    { name: 'word/_rels/document.xml.rels', body: DOC_RELS },
    { name: 'word/styles.xml', body: STYLES },
    { name: 'word/document.xml', body: documentXml(resumeText) },
  ];
}

function writeU32(out: number[], n: number): void {
  out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}
function writeU16(out: number[], n: number): void {
  out.push(n & 0xff, (n >>> 8) & 0xff);
}

/**
 * The .docx, as bytes.
 *
 * Returns the bytes rather than a Blob so this is testable under Node, where the
 * output can be handed straight back to the same unzipper the app uses for
 * uploads. A writer nobody can read is a writer nobody should trust.
 */
export async function docxBytes(resumeText: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;
  let count = 0;

  for (const part of parts(resumeText)) {
    const raw = encoder.encode(part.body);
    const { data, method } = await deflateRaw(raw);
    const nameBytes = encoder.encode(part.name);
    const crc = crc32(raw);

    const localStart = offset;

    // Local file header.
    writeU32(local, 0x04034b50);
    writeU16(local, 20); // version needed
    writeU16(local, 0); // flags
    writeU16(local, method);
    writeU16(local, 0); // mod time — zero, so the same text gives the same bytes
    writeU16(local, 0x21); // mod date: 1 Jan 1980, the ZIP epoch
    writeU32(local, crc);
    writeU32(local, data.length);
    writeU32(local, raw.length);
    writeU16(local, nameBytes.length);
    writeU16(local, 0); // extra
    for (const b of nameBytes) local.push(b);
    for (const b of data) local.push(b);
    offset = local.length;

    // Central directory entry.
    writeU32(central, 0x02014b50);
    writeU16(central, 20); // version made by
    writeU16(central, 20); // version needed
    writeU16(central, 0);
    writeU16(central, method);
    writeU16(central, 0);
    writeU16(central, 0x21);
    writeU32(central, crc);
    writeU32(central, data.length);
    writeU32(central, raw.length);
    writeU16(central, nameBytes.length);
    writeU16(central, 0); // extra
    writeU16(central, 0); // comment
    writeU16(central, 0); // disk
    writeU16(central, 0); // internal attributes
    writeU32(central, 0); // external attributes
    writeU32(central, localStart);
    for (const b of nameBytes) central.push(b);
    count++;
  }

  const eocd: number[] = [];
  writeU32(eocd, 0x06054b50);
  writeU16(eocd, 0); // this disk
  writeU16(eocd, 0); // disk with the central directory
  writeU16(eocd, count);
  writeU16(eocd, count);
  writeU32(eocd, central.length);
  writeU32(eocd, local.length); // where the central directory starts
  writeU16(eocd, 0); // comment length

  return new Uint8Array([...local, ...central, ...eocd]);
}

/** The .docx as a Blob, for a download in the browser. */
export async function docxBlob(resumeText: string): Promise<Blob> {
  const bytes = await docxBytes(resumeText);
  return new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

/**
 * A file name a person can find again.
 *
 * The job title in it, because somebody tailoring for six roles ends up with six
 * of these in one folder and "resume.docx (3)" tells them nothing.
 */
export function docxFileName(jobTitle: string): string {
  const slug = jobTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug ? `resume-${slug}.docx` : 'resume.docx';
}
