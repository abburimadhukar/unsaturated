/**
 * Reads the text out of a resume file, in the browser.
 *
 * In the browser and not on the server, for two reasons. The site runs on
 * Cloudflare Workers, where a request gets a small CPU budget and parsing a PDF
 * is the kind of work that blows it. And the file is already here — uploading it
 * only to have it sent back as text is a round trip for nothing.
 *
 * Extraction is BEST EFFORT and the upload never depends on it. A scanned PDF
 * with no text layer is a real thing people will try, and the right answer is to
 * keep their file, say plainly that no text came out of it, and offer the paste
 * box — not to refuse the upload.
 */

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

export const ACCEPTED = '.pdf,.docx,.txt,.md';

export interface ExtractResult {
  text: string;
  /** What to tell the person when the text is thin or absent. */
  warning: string | null;
}

/** Enough words that the skill matcher has something to work with. */
const MIN_USEFUL_CHARS = 200;

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/**
 * A .docx is a ZIP holding word/document.xml.
 *
 * Unzipped by hand rather than with a library: the browser already ships an
 * inflater in DecompressionStream, and the only entry needed is one known
 * filename. A dependency to read one file out of one archive is not worth the
 * bytes on a page most people will never use.
 */
async function docxText(buf: ArrayBuffer): Promise<string> {
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

    if (name === 'word/document.xml') {
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
  throw new Error('no document.xml inside');
}

/**
 * Word's XML, as readable text.
 *
 * Paragraph and line-break tags become newlines BEFORE the tags are stripped —
 * otherwise every heading runs into the sentence after it and "React Developer"
 * and "Skills" become one word the matcher never sees.
 */
function xmlToText(xml: string): string {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, ' ')
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

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function pdfText(buf: ArrayBuffer): Promise<string> {
  // Imported dynamically so the library is its own chunk, fetched only when
  // somebody actually picks a PDF. It is by far the largest thing this site
  // could load, and most visitors never will.
  const pdfjs = await import('pdfjs-dist');
  // The worker is bundled alongside; pointing at it explicitly stops pdf.js
  // reaching for a CDN copy that the page's own origin rules may refuse.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const out: string[] = [];
  // Bounded: a resume is a handful of pages, and a 400-page PDF should not lock
  // the tab up while it is read.
  const pages = Math.min(doc.numPages, 20);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    out.push(
      content.items
        .map((i) => ('str' in i ? i.str : ''))
        .join(' ')
        .replace(/\s+/g, ' '),
    );
  }
  await doc.destroy();
  return out.join('\n\n').trim();
}

// ---------------------------------------------------------------------------

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
function stripControlChars(text: string): string {
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

export function isAcceptedFile(name: string): boolean {
  return /\.(pdf|docx|txt|md)$/i.test(name);
}

/**
 * Text from a resume file, and an honest note when there is little of it.
 *
 * Never throws for a file it simply could not read: the caller stores the file
 * either way, and a warning the person can act on beats an error that loses
 * their upload.
 */
export async function extractResumeText(file: File): Promise<ExtractResult> {
  const name = file.name.toLowerCase();

  if (file.size > MAX_RESUME_BYTES) {
    return { text: '', warning: 'That file is over 5 MB — too large to store.' };
  }

  let text = '';
  try {
    if (name.endsWith('.pdf')) {
      text = await pdfText(await file.arrayBuffer());
    } else if (name.endsWith('.docx')) {
      text = xmlToText(await docxText(await file.arrayBuffer()));
    } else if (name.endsWith('.txt') || name.endsWith('.md')) {
      text = await file.text();
    } else if (name.endsWith('.doc')) {
      return {
        text: '',
        warning:
          'Old .doc files are not readable here. Save it as .docx or PDF, or paste the text below.',
      };
    } else {
      return { text: '', warning: 'Use a PDF, DOCX, TXT or Markdown file.' };
    }
  } catch (err) {
    return {
      text: '',
      warning: `Could not read that file (${
        err instanceof Error ? err.message : 'unknown error'
      }). It has been kept — paste the text below to get a match score.`,
    };
  }

  const clean = stripControlChars(text);
  if (clean.length < MIN_USEFUL_CHARS) {
    return {
      text: clean,
      // The usual cause is a scan or an image-only export, which no amount of
      // retrying fixes — so say what to do instead of what went wrong.
      warning:
        'Almost no text came out of that file — it may be a scan. Your file is kept, but paste the text below for a match score.',
    };
  }
  return { text: clean, warning: null };
}
