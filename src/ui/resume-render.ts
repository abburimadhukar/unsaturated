import { looksLikeHeading } from './docx.js';

/**
 * Reading plain resume text as a document, so it can be shown as one.
 *
 * WHY A TEXTAREA WAS NOT ENOUGH
 *
 * The tailored resume came back in a monospace box. Everything was there and
 * nothing about it looked like a resume, which made the one question a person
 * actually has — "would I send this?" — impossible to answer from the screen. A
 * document has to be shown as a document before anybody can judge it.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a reading of the TEXT, which means it can recover structure the text
 * carries — a name, section headings, bullets, blank lines — and nothing it does
 * not. If somebody uploaded a two-column CV with a headshot, this does not show
 * that; it shows their words, laid out legibly.
 *
 * Which is honest for the generated .docx, because that is exactly what it
 * contains. It is NOT a preview of the in-place .docx edit, where their own layout
 * survives and this would be showing something different from what downloads.
 * Whichever is on offer, the page has to say which.
 *
 * THE HEADING TEST IS SHARED WITH THE WRITER
 *
 * looksLikeHeading comes from docx.ts rather than being written again here. Two
 * copies would drift, and the symptom would be a preview that bolds a line the
 * downloaded file does not — the preview lying about the document in the one way
 * that matters.
 */

export type BlockKind = 'name' | 'contact' | 'heading' | 'bullet' | 'body' | 'blank';

export interface Block {
  kind: BlockKind;
  /** The line, with any bullet marker removed. */
  text: string;
  /** The marker that was stripped, so it can be rendered as one. */
  marker?: string;
  /** Index of the source line, so a changed line can be pointed at. */
  line: number;
}

/**
 * The characters people actually start a resume bullet with.
 *
 * Extracted rather than kept in the text, so the rendering can hang the indent
 * properly — a wrapped bullet whose second line starts under the marker reads as a
 * separate point.
 */
const BULLET_RE = /^\s*([-–—•*·▪‣◦])\s+/;

/** An indented line without a marker is still a sub-point. */
const INDENTED_RE = /^(\s{2,}|\t)/;

/**
 * A line that is contact details rather than prose.
 *
 * Shown smaller and quieter under the name, which is where it belongs and how
 * every resume already formats it. Recognised by what it contains rather than by
 * position, because plenty of CVs put the address on line four.
 */
function looksLikeContact(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  const signals = [
    /@[\w.-]+\.\w{2,}/, // an email
    /\+?\d[\d\s()-]{7,}/, // a phone number
    /\b(linkedin|github|gitlab)\b/i,
    /\bhttps?:\/\//i,
  ];
  return signals.some((re) => re.test(t));
}

/**
 * The text as a list of blocks.
 *
 * Deterministic and side-effect free, so it can be tested without a browser. The
 * component does nothing but render what this returns.
 */
export function readResume(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const firstReal = lines.findIndex((l) => l.trim().length > 0);
  const out: Block[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (!trimmed) {
      out.push({ kind: 'blank', text: '', line: i });
      continue;
    }

    if (i === firstReal) {
      out.push({ kind: 'name', text: trimmed, line: i });
      continue;
    }

    const bullet = BULLET_RE.exec(raw);
    if (bullet) {
      out.push({
        kind: 'bullet',
        text: raw.replace(BULLET_RE, '').trim(),
        marker: bullet[1]!,
        line: i,
      });
      continue;
    }

    if (looksLikeHeading(trimmed)) {
      out.push({ kind: 'heading', text: trimmed, line: i });
      continue;
    }

    // Contact details only near the top. Further down, a line with a URL in it is
    // a project link inside a bullet, not a header block.
    if (i - firstReal <= 3 && looksLikeContact(trimmed)) {
      out.push({ kind: 'contact', text: trimmed, line: i });
      continue;
    }

    // An indented line with no marker is still a sub-point, and rendering it flush
    // left loses the only thing that said so.
    if (INDENTED_RE.test(raw)) {
      out.push({ kind: 'bullet', text: trimmed, line: i });
      continue;
    }

    out.push({ kind: 'body', text: trimmed, line: i });
  }

  return out;
}

/**
 * Which lines of the tailored text are the accepted replacements.
 *
 * So the preview can mark them. Matched on collapsed whitespace, because the
 * replacement was written by a model and the document it landed in may differ by a
 * space.
 *
 * Returns line indexes rather than booleans per block: a replacement may appear
 * more than once if somebody accepted two edits with the same wording, and every
 * occurrence should be marked rather than only the first.
 */
export function changedLines(text: string, replacements: readonly string[]): Set<number> {
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = new Set(replacements.map(collapse).filter((s) => s.length > 0));
  const marked = new Set<number>();
  if (wanted.size === 0) return marked;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = collapse(lines[i]!.replace(BULLET_RE, ''));
    if (!line) continue;
    // Exact, or the line contains the replacement — which happens when the
    // replacement was spliced into the middle of a longer line.
    for (const w of wanted) {
      if (line === w || line.includes(w)) {
        marked.add(i);
        break;
      }
    }
  }
  return marked;
}
