/**
 * The parts of reading a résumé that need no PDF library.
 *
 * Shared by the website (resume-file.ts) and the browser extension, which
 * bundles this file rather than keeping a second copy. Two copies of an unzipper
 * drift the first time one of them learns about a new Word quirk.
 */

/**
 * A .docx is a ZIP holding word/document.xml.
 *
 * Unzipped by hand rather than with a library: the browser already ships an
 * inflater in DecompressionStream, and the only entry needed is one known
 * filename. A dependency to read one file out of one archive is not worth the
 * bytes on a page most people will never use.
 */
export async function docxText(buf: ArrayBuffer): Promise<string> {
  const xml = await zipEntry(buf, 'word/document.xml');
  if (xml === null) throw new Error('no document.xml inside');
  return xml;
}

/**
 * One file out of a ZIP, as text, or null when the archive does not hold it.
 *
 * The extension also reads word/_rels/document.xml.rels, where Word keeps the
 * address behind a link: a résumé that says "LinkedIn" hides the URL there.
 */
export async function zipEntry(buf: ArrayBuffer, wanted: string): Promise<string | null> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // The end-of-central-directory record is last, after a comment of unknown
  // length, so it is found by scanning backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66_000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    if (name === wanted) {
      // The local header repeats the name and extra fields, and its own lengths
      // are the authoritative ones — the central directory's extra length is
      // frequently different.
      const localNameLen = view.getUint16(localAt + 26, true);
      const localExtraLen = view.getUint16(localAt + 28, true);
      const start = localAt + 30 + localNameLen + localExtraLen;
      const data = bytes.subarray(start, start + compressedSize);

      // 0 is stored, 8 is deflate. Nothing else appears in a .docx.
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8) throw new Error(`unsupported compression (${method})`);

      const stream = new Blob([data]).stream().pipeThrough(
        new DecompressionStream('deflate-raw'),
      );
      return await new Response(stream).text();
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * Word's XML, as readable text.
 *
 * Paragraph and line-break tags become newlines BEFORE the tags are stripped —
 * otherwise every heading runs into the sentence after it and "React Developer"
 * and "Skills" become one word the matcher never sees.
 *
 * TWO KINDS OF TEXT WORD DOES NOT SHOW, AND NOR SHOULD THIS
 *
 * Stripping tags keeps everything BETWEEN them, and not every text node in a
 * .docx is text the document displays:
 *
 *   <w:instrText>  a field's instructions rather than its result — ` HYPERLINK
 *                  "mailto:someone@example.com" `, ` PAGE `, ` REF _Ref4471 `.
 *                  Word renders the result; this was pasting the instruction
 *                  into the middle of somebody's CV.
 *   <w:delText>    text DELETED under tracked changes. Word shows it struck
 *                  through, or not at all once the changes are accepted. Keeping
 *                  it puts sentences the person removed back into the document
 *                  an employer receives, which is the worse of the two.
 *
 * Both are dropped with their contents, before the general strip can unwrap
 * them. Everything else still unwraps, because <w:t> and its neighbours are the
 * text the document actually shows.
 */
export function xmlToText(xml: string): string {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, ' ')
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

/**
 * Removes the control characters PDF and DOCX extraction leaves behind.
 *
 * Written as a code-point test rather than a regular expression on purpose.
 * The obvious version needs escapes for NUL and friends, and one of them typed
 * as the CHARACTER instead of the escape is invisible in every editor while
 * still compiling. This project has already lost hours to exactly that with
 * backspace bytes, which is why source-hygiene reads these files as bytes.
 * There is nothing here to get wrong.
 */
export function stripControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const keep = code >= 32 || ch === NEWLINE || ch === TAB;
    out += keep ? ch : ' ';
  }
  return out
    .split(NEWLINE)
    .map((line) => line.replace(TAB, ' ').split(' ').filter(Boolean).join(' '))
    .join(NEWLINE)
    .trim();
}

