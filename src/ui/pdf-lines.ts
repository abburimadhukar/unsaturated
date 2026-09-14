/**
 * Putting the lines back into text extracted from a PDF.
 *
 * WHAT WAS WRONG
 *
 * The reader joined every text item on a page with a single space and collapsed
 * all whitespace, so a page of a resume came out as ONE line. Everything was
 * there and none of the structure was: no name on its own, no section headings,
 * no bullets. Which matters more here than it sounds, because every downstream
 * step reads structure out of the text — readResume renders headings and bullets
 * from it, the .docx writer bolds headings from it, and applyEdits splices line by
 * line. Fed one 4,000-character line they all degrade to "one paragraph", and the
 * person's CV comes back as a wall of prose.
 *
 * WHY A PDF NEEDS THIS AT ALL
 *
 * A PDF has no lines. It has glyphs at coordinates, and "line" is something a
 * reader infers from where they sit. So the lines are rebuilt from the positions:
 * items that share a baseline are one line, a bigger vertical step than usual is a
 * paragraph break, and a horizontal gap wider than a space is a space.
 *
 * PURE, AND SEPARATE FROM pdf.js ON PURPOSE
 *
 * This takes plain objects and returns a string, so the interesting part can be
 * tested with a handful of coordinates rather than by building a PDF. The library
 * call in resume-file.ts does nothing but hand its items over.
 */

export interface TextItem {
  str: string;
  /**
   * The PDF text matrix, [a, b, c, d, e, f]. e is x and f is y, in a space whose
   * origin is the BOTTOM-left — so a larger y is higher up the page.
   */
  transform: number[];
  /** Width of the item's own text, in the same units. */
  width: number;
  /** Height of the glyphs. pdf.js supplies it; treated as optional for safety. */
  height?: number;
}

interface Placed {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fallback glyph height when the library does not give one. Roughly 10pt. */
const DEFAULT_HEIGHT = 10;

/**
 * How far two items' baselines may differ and still be one line.
 *
 * A fraction of the glyph height rather than a fixed number of units, because the
 * same page holds an 18pt name and a 9pt footer. Superscripts and mixed fonts
 * shift a baseline slightly; a genuine new line moves it by a whole line.
 */
const SAME_LINE = 0.5;

/**
 * How wide a horizontal gap has to be before it means a space.
 *
 * PDF writers split a line into runs wherever anything changes — a font, a
 * colour, kerning — so adjacent runs are usually parts of one word. Joining every
 * run with a space is what produces "Ran multi - region AWS"; joining none of them
 * produces "Ranmulti-regionAWS", which is the failure that matters because the
 * first reader of a resume is usually a parser. The gap decides.
 */
const SPACE_GAP = 0.22;

/**
 * How much bigger than the usual line step counts as a paragraph break.
 *
 * Measured against the MEDIAN step on the page rather than a constant, because a
 * densely set CV and an airy one have different natural spacing and neither is
 * wrong. 1.6 clears ordinary line spacing and catches the gap a heading sits in.
 */
const PARAGRAPH = 1.6;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * One page's items as text, with its lines back.
 *
 * Blank lines are emitted for paragraph breaks, because a resume's structure is
 * carried almost entirely by them: readResume finds a section heading partly by
 * what sits above it.
 */
export function linesFromItems(items: readonly TextItem[]): string {
  const placed: Placed[] = [];
  for (const it of items) {
    // Whitespace-only runs carry no text and their width is unreliable, so they
    // are dropped and the gap between their neighbours is used instead.
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform;
    if (!Array.isArray(t) || t.length < 6) continue;
    placed.push({
      s: it.str,
      x: t[4]!,
      y: t[5]!,
      w: typeof it.width === 'number' ? it.width : 0,
      h: typeof it.height === 'number' && it.height > 0 ? it.height : DEFAULT_HEIGHT,
    });
  }
  if (placed.length === 0) return '';

  // Down the page, then across it. Reading order, which is not the order a PDF
  // stores its glyphs in — writers emit them in whatever order suits them.
  placed.sort((a, b) => b.y - a.y || a.x - b.x);

  // --- group into lines by baseline ------------------------------------------
  const rows: Placed[][] = [];
  let row: Placed[] = [placed[0]!];
  let baseline = placed[0]!.y;
  for (let i = 1; i < placed.length; i++) {
    const p = placed[i]!;
    if (Math.abs(p.y - baseline) <= p.h * SAME_LINE) {
      row.push(p);
    } else {
      rows.push(row);
      row = [p];
      baseline = p.y;
    }
  }
  rows.push(row);

  // --- the usual vertical step, so an unusual one can be recognised -----------
  const steps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    steps.push(Math.abs(rows[i - 1]![0]!.y - rows[i]![0]!.y));
  }
  const step = median(steps);

  // --- each line's text, with spaces where the gaps say so --------------------
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const items2 = rows[i]!.slice().sort((a, b) => a.x - b.x);
    let text = items2[0]!.s;
    for (let k = 1; k < items2.length; k++) {
      const prev = items2[k - 1]!;
      const cur = items2[k]!;
      const gap = cur.x - (prev.x + prev.w);
      const needsSpace = gap > cur.h * SPACE_GAP;
      // Never doubled: a run that already ends in a space, or begins with one,
      // has said so itself.
      const joined = /\s$/.test(text) || /^\s/.test(cur.s);
      text += needsSpace && !joined ? ` ${cur.s}` : cur.s;
    }
    text = text.replace(/[ \t]+/g, ' ').trim();
    if (!text) continue;

    // A step noticeably larger than the page's usual one is a paragraph break.
    if (i > 0 && step > 0) {
      const drop = Math.abs(rows[i - 1]![0]!.y - rows[i]![0]!.y);
      if (drop > step * PARAGRAPH) out.push('');
    }
    out.push(text);
  }

  return out.join('\n');
}
