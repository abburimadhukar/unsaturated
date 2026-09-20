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

import { linesFromItems, type TextItem } from './pdf-lines.js';
import { cleanResumeText } from './resume-clean.js';
import { docxText, xmlToText, stripControlChars } from './resume-read-core.js';

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

export const ACCEPTED = '.pdf,.docx,.txt,.md';

export interface ExtractResult {
  text: string;
  /** What to tell the person when the text is thin or absent. */
  warning: string | null;
  /** Converter damage that was repaired, so the person is told rather than surprised. */
  repairs?: string[];
  /** Damage that cannot be repaired from the text alone, only reported. */
  warnings?: string[];
}

/** Enough words that the skill matcher has something to work with. */
const MIN_USEFUL_CHARS = 200;

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
    // Lines rebuilt from the glyph positions rather than joined with spaces.
    // A PDF has no lines — it has glyphs at coordinates — and flattening a page
    // into one string threw away the structure every later step reads back out:
    // headings, bullets, the name on its own. See pdf-lines.ts.
    out.push(linesFromItems(content.items as unknown as TextItem[]));
  }
  await doc.destroy();
  return out.join('\n\n').trim();
}

// ---------------------------------------------------------------------------

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

  // Converter damage undone before anything else sees the text. A CV that has
  // been through PDF-to-Word arrives with ligatures where letters belong and the
  // converter's own object ids pasted in as lines, and every later step — the
  // skill matcher, the tailoring model, the employer reading the download —
  // inherits both. See resume-clean.ts.
  const repaired = cleanResumeText(stripControlChars(text));
  const clean = repaired.text;

  if (clean.length < MIN_USEFUL_CHARS) {
    return {
      text: clean,
      // The usual cause is a scan or an image-only export, which no amount of
      // retrying fixes — so say what to do instead of what went wrong.
      warning:
        'Almost no text came out of that file — it may be a scan. Your file is kept, but paste the text below for a match score.',
      repairs: repaired.repairs,
      warnings: repaired.warnings,
    };
  }
  return { text: clean, warning: null, repairs: repaired.repairs, warnings: repaired.warnings };
}
