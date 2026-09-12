/**
 * Writing a .docx, with no library.
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

/** Longest line treated as a possible heading. */
const MAX_HEADING_CHARS = 40;

/**
 * Whether a line is a section heading.
 *
 * Conservative on purpose, and the test is shape rather than vocabulary: short,
 * no sentence-ending punctuation, and no lowercase letters. "EXPERIENCE" and
 * "TECHNICAL SKILLS" match; "Managed AWS and Azure" does not, because of the
 * lowercase; "AWS, Azure, Kubernetes, Terraform, Docker, CI/CD" does not, because
 * of the length.
 *
 * Getting this wrong costs a line of bold text, not a broken document — so the
 * bias is towards missing a heading rather than bolding a bullet.
 */
export function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > MAX_HEADING_CHARS) return false;
  if (/[.!?,;:]$/.test(t)) return false;
  if (/[a-z]/.test(t)) return false;
  // At least one letter, so a line of dashes or digits is not a heading.
  return /[A-Z]/.test(t);
}

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

/** One paragraph, with a size and an optional bold run. */
function paragraph(text: string, halfPoints: number, bold: boolean): string {
  const sz = `<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>`;
  const b = bold ? '<w:b/><w:bCs/>' : '';
  // An empty line is a paragraph with no run, which is how Word represents a
  // blank line. Emitting a run containing nothing makes Word show a stray space.
  if (text.length === 0) {
    return `<w:p><w:pPr><w:rPr>${sz}</w:rPr></w:pPr></w:p>`;
  }
  return (
    `<w:p><w:pPr><w:rPr>${b}${sz}</w:rPr></w:pPr>` +
    `<w:r><w:rPr>${b}${sz}</w:rPr>` +
    // xml:space preserve, or Word eats the leading spaces that carry a CV's
    // indentation.
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

/** The document body, from plain text. */
export function documentXml(resumeText: string): string {
  const lines = resumeText.replace(/\r\n?/g, '\n').split('\n');
  const body = lines
    .map((line, i) => {
      const trimmedEnd = line.replace(/\s+$/, '');
      // The first non-empty line is the name, which is the one piece of a resume
      // that is always a heading whatever it says.
      const isName = i === lines.findIndex((l) => l.trim().length > 0);
      if (isName) return paragraph(trimmedEnd, NAME_HALF_POINTS, true);
      if (looksLikeHeading(trimmedEnd)) return paragraph(trimmedEnd, HEADING_HALF_POINTS, true);
      return paragraph(trimmedEnd, BODY_HALF_POINTS, false);
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}` +
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
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  `<w:sz w:val="${BODY_HALF_POINTS}"/><w:szCs w:val="${BODY_HALF_POINTS}"/>` +
  '</w:rPr></w:rPrDefault>' +
  // 4pt after each paragraph and single line spacing, so the lines of a CV read
  // as a list rather than as one block.
  '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults></w:styles>';

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
