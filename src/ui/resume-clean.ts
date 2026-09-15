/**
 * Repairing what a file converter did to somebody's CV — and nothing else.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * A real resume arrived as a .docx that had plainly been converted from a PDF,
 * and the conversion left three kinds of damage. None of it is visible on screen,
 * all of it reaches an employer, and one of it changed what the tailoring model
 * concluded about the candidate:
 *
 *   LIGATURES    "eﬃciency" is not "efficiency". It is one character, U+FB03,
 *                that LOOKS like f-f-i. A recruiter's search for "efficiency"
 *                does not match it, and neither does any keyword filter.
 *
 *   ENTITIES     Numeric character references left undecoded, so "&#39;" sits in
 *                the text where an apostrophe belongs.
 *
 *   ARTEFACTS    A line of bare digits after every section heading — 25400050782
 *                under TECHNICAL SKILLS, 25400045313 under PROFESSIONAL
 *                EXPERIENCE, 25400046444 under EDUCATION. Object ids from the
 *                converter, pasted into the document as text.
 *
 * THE FIRST TWO ARE FIXED. THE THIRD IS ONLY EVER REPORTED.
 *
 * That split is the whole design, and it was learned the hard way. Ligatures and
 * entities are LOSSLESS character corrections: U+FB03 becomes f-f-i and the
 * document says exactly what it said before, only in characters a search engine
 * can read. Nothing can be lost by doing it.
 *
 * Deleting a line is a different act entirely, and this file used to do it. It
 * deleted any line of eight or more bare digits below the fourth line, which ate:
 *
 *   - a phone number, on a clean CV whose header ran to five lines
 *   - a certification or reference number, anywhere below the header
 *
 * and then reported "removed 1 line of stray digits left by the converter" about
 * a file no converter had ever touched. Told that their resume was clean and the
 * code was not, that is what the check found.
 *
 * So nothing is deleted here. A suspected artefact is kept, named, and left to
 * its owner — who is the only one who knows whether 07700900123 is a converter's
 * object id or how to reach them.
 *
 * AND ONE BARE NUMBER IS NOT EVIDENCE OF ANYTHING
 *
 * The evidence in the real case was never "a long number appeared". It was that
 * THREE of them appeared, all eleven digits, all beginning 254000, one under each
 * section heading. That is a pattern; a single long number is a phone.
 */

/** Shortest run of bare digits that could be an object id rather than a number. */
const ARTEFACT_DIGITS = 8;

/**
 * Lines at the very top that are never suspected.
 *
 * The header is where a phone number lives, and a phone number written bare —
 * "4045667011" — is a legitimate line of nothing but digits.
 */
const HEADER_LINES = 4;

/**
 * How many leading digits two artefacts must share.
 *
 * The real ones shared six (254000). Five is enough to separate a converter's
 * sequential ids from two unrelated numbers, and two unrelated numbers that share
 * five leading digits AND a length are not worth designing around, because the
 * only consequence now is a sentence somebody can ignore.
 */
const SHARED_PREFIX = 5;

/** At least this many matching lines before it is a pattern rather than a number. */
const MIN_REPEATS = 2;

export interface CleanResult {
  /** The text with lossless character repairs applied. Nothing is ever removed. */
  text: string;
  /** Character-level repairs actually made. One short sentence each. */
  repairs: string[];
  /** Things to look at. NOTHING was changed for any of these. */
  warnings: string[];
}

/**
 * Ligatures, and the other lookalikes a PDF leaves behind.
 *
 * NFKC does the work: it maps every ligature to its letters, and also normalises
 * the full-width and styled variants that some converters emit. It does not touch
 * accents or ordinary letters, so a name stays spelled the way its owner spells
 * it.
 */
function unligature(text: string): string {
  return text.normalize('NFKC');
}

/** Numeric character references, which the docx reader's named-entity list misses. */
function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#(\d{1,7});/g, (_, d: string) => {
      const code = Number(d);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h: string) => {
      const code = parseInt(h, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}

/**
 * Bare-digit lines that look like a converter's object ids, by their pattern.
 *
 * Returns the 1-based line numbers, so a person can find them. Never used to
 * remove anything — see the note at the top of this file.
 *
 * A line qualifies only as part of a GROUP: two or more lines of identical length
 * sharing five leading digits, all below the header. One long number on its own
 * is a phone number, an employee number, or a certification id, and every one of
 * those belongs in the document.
 */
export function suspectedArtefacts(text: string): { line: string; at: number }[] {
  const candidates: { line: string; at: number }[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (i < HEADER_LINES) continue;
    const t = (lines[i] ?? '').trim();
    if (t.length >= ARTEFACT_DIGITS && /^\d+$/.test(t)) candidates.push({ line: t, at: i + 1 });
  }

  // Grouped by shape: same length, same leading digits. The converter numbers its
  // objects sequentially, so its ids agree on both.
  const groups = new Map<string, { line: string; at: number }[]>();
  for (const c of candidates) {
    const key = `${c.line.length}:${c.line.slice(0, SHARED_PREFIX)}`;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }

  const out: { line: string; at: number }[] = [];
  for (const group of groups.values()) {
    if (group.length >= MIN_REPEATS) out.push(...group);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A bare "C" where "C#" almost certainly was.
 *
 * Detected, never corrected. "C" is a real language and a real thing to list, so
 * the only honest move is to say what looks wrong and let its owner decide.
 */
function suspectsLostSharp(text: string): boolean {
  if (!/\b(ASP\.NET|VB\.NET|\.NET)\b/i.test(text)) return false;

  for (const line of text.split('\n')) {
    if (!/\b(languages?|skills|programming)\b/i.test(line)) continue;
    // Either suffix on the line settles it. Somebody who wrote "C++" plainly
    // knows to write the suffix when they mean one, so the bare C beside it is
    // deliberate — "C, C++, Java" is how that list is spelled.
    //
    // Checking only for C# was the bug: it fired on every clean CV listing C and
    // C++ next to ASP.NET, and told its owner a converter had eaten a character
    // that had never been there.
    if (/\bC#/.test(line) || /\bC\+\+/.test(line)) continue;
    if (/\bC\b(?!\+|#)/.test(line)) return true;
  }
  return false;
}

/**
 * A CV, with the damage a converter did to it undone where that is lossless and
 * reported where it is not. The text only ever changes character for character.
 */
export function cleanResumeText(raw: string): CleanResult {
  const repairs: string[] = [];
  const warnings: string[] = [];

  let text = raw.replace(/\r\n?/g, '\n');

  const unligatured = unligature(text);
  if (unligatured !== text) {
    // Counted, because "we changed four words" is checkable and "we tidied your
    // file" is not.
    const before = [...text].filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n >= 0xfb00 && n <= 0xfb06;
    }).length;
    if (before > 0) {
      repairs.push(
        `joined ${before} squashed letter${before === 1 ? '' : 's'} (ﬁ, ﬂ, ﬃ) back into ordinary ones — a search for "efficiency" would not have matched "eﬃciency"`,
      );
    }
    text = unligatured;
  }

  const decoded = decodeNumericEntities(text);
  if (decoded !== text) {
    repairs.push('decoded character codes left in the text by the converter');
    text = decoded;
  }

  const artefacts = suspectedArtefacts(text);
  if (artefacts.length > 0) {
    warnings.push(
      `Line${artefacts.length === 1 ? '' : 's'} ${artefacts.map((a) => a.at).join(', ')} ` +
        `${artefacts.length === 1 ? 'is a row' : 'are rows'} of bare digits ` +
        `(${artefacts.slice(0, 3).map((a) => a.line).join(', ')}). ` +
        'PDF-to-Word converters leave their own object ids behind like this. ' +
        'Nothing has been removed — delete them yourself if they are not yours.',
    );
  }

  if (suspectsLostSharp(text)) {
    warnings.push(
      'Your resume lists "C" on its own beside .NET technologies. A PDF-to-Word converter drops the "#" from "C#", and a reader cannot tell which you meant — check it and fix it if it should be C#.',
    );
  }

  return { text: text.trim(), repairs, warnings };
}
