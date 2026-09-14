/**
 * Repairing what a file converter did to somebody's CV.
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
 *                does not match it, and neither does any keyword filter. Four
 *                words on that CV were affected and nothing on the page said so.
 *
 *   ARTEFACTS    A line of bare digits after every section heading — 25400050782
 *                under TECHNICAL SKILLS, 25400045313 under PROFESSIONAL
 *                EXPERIENCE, 25400046444 under EDUCATION. Object ids from the
 *                converter, pasted into the document as text.
 *
 *   ENTITIES     Numeric character references left undecoded, so "&#39;" sits in
 *                the text where an apostrophe belongs.
 *
 * The fourth kind cannot be repaired here and is only detected: the same
 * conversion turned "C#" into "C", and the tailoring model duly reported "the
 * resume lists C, but not C++" as a gap. A lost character is not recoverable from
 * the text that survived it — guessing which bare "C" was once "C#" would be
 * inventing, which is the one thing this codebase does not do. So it is reported
 * to the person instead, who is the only one who knows.
 *
 * CONSERVATIVE ON PURPOSE
 *
 * This runs over somebody's CV unattended. Every rule here has to be one that
 * cannot eat real content, which is why the digit rule is narrow and why nothing
 * guesses at a replacement.
 */

/** Shortest run of bare digits treated as an artefact rather than a number. */
const ARTEFACT_DIGITS = 8;

/**
 * Lines at the very top that are exempt from the digit rule.
 *
 * The header is where a phone number lives, and a phone number written bare —
 * "4045667011" — is the one legitimate line of nothing but digits a CV can have.
 * Further down there is no such thing.
 */
const HEADER_LINES = 4;

export interface CleanResult {
  text: string;
  /** What was repaired, for telling the person. One short sentence each. */
  repairs: string[];
  /** Damage that cannot be repaired from the text alone. */
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
 * Whether a line is a converter's object id rather than anything a person wrote.
 *
 * Narrow deliberately. It must be the WHOLE line, it must be all digits, it must
 * be long enough that no year, no page number and no street number qualifies, and
 * it must be below the header where a bare phone number would sit.
 */
export function isArtefactLine(line: string, index: number): boolean {
  if (index < HEADER_LINES) return false;
  const t = line.trim();
  return t.length >= ARTEFACT_DIGITS && /^\d+$/.test(t);
}

/**
 * A bare "C" where "C#" almost certainly was.
 *
 * Detected, never corrected. "C" is a real language and a real thing to list, so
 * the only honest move is to say what looks wrong and let its owner decide. The
 * signal is a .NET resume — nobody writing C without a sharp lists it beside
 * ASP.NET and VB.NET.
 */
function suspectsLostSharp(text: string): boolean {
  if (!/\b(ASP\.NET|VB\.NET|\.NET)\b/i.test(text)) return false;

  // Judged LINE BY LINE, and only on a line listing languages or skills.
  //
  // An earlier version asked whether the document contained "C#" anywhere and
  // stayed quiet if it did. That was backwards, and it stayed quiet on the resume
  // that prompted this: the skills line read "ASP.NET, C, SQL" while an
  // experience bullet further down read "using C# and VB.NET". Writing it
  // correctly in one place and bare in another is STRONGER evidence that a
  // character was lost, not weaker.
  //
  // Per line, because "C, C#, C++" is a real and correct thing to write — there
  // the bare C is deliberate, and the C# beside it says so.
  for (const line of text.split('\n')) {
    if (!/\b(languages?|skills|programming)\b/i.test(line)) continue;
    if (/\bC#/.test(line)) continue;
    if (/\bC\b(?!\+|#)/.test(line)) return true;
  }
  return false;
}

/**
 * A CV, with the damage a converter did to it undone where that is possible and
 * reported where it is not.
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

  const lines = text.split('\n');
  const dropped: string[] = [];
  const kept = lines.filter((line, i) => {
    if (!isArtefactLine(line, i)) return true;
    dropped.push(line.trim());
    return false;
  });
  if (dropped.length > 0) {
    repairs.push(
      `removed ${dropped.length} line${dropped.length === 1 ? '' : 's'} of stray digits left by the converter (${dropped.slice(0, 3).join(', ')})`,
    );
    text = kept.join('\n');
  }

  if (suspectsLostSharp(text)) {
    warnings.push(
      'Your resume lists "C" on its own beside .NET technologies. A PDF-to-Word converter drops the "#" from "C#", and a reader cannot tell which you meant — check it and fix it if it should be C#.',
    );
  }

  return { text: text.trim(), repairs, warnings };
}
