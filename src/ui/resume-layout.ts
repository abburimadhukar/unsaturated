/**
 * What each line of a resume IS. One answer, for every renderer.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * There are two renderers — the .docx writer and the browser print view that
 * makes the PDF — and they each had their own idea of what a line was. The .docx
 * learned to split an employer line, embolden a skills label and italicise a role;
 * the print view did not, so the same resume came out as two different documents
 * depending on which button was pressed. That is not a bug to fix once. It is two
 * implementations of one question, and they will drift again the moment either is
 * touched.
 *
 * So the question is answered here, once, and both renderers are handed the
 * answer. Adding a line kind now changes both or neither.
 *
 * EVERY RULE IS SHAPE, NOT VOCABULARY
 *
 * A date range at the end of a line makes it an employer. A colon in the skills
 * section marks a label. A leading marker makes a bullet. None of it asks what
 * industry the person is in, so a nurse's "CLINICAL SKILLS" and an accountant's
 * "Standards: IFRS 16, US GAAP" lay out exactly as an engineer's do.
 */

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
 */
export function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > MAX_HEADING_CHARS) return false;
  if (/[.!?,;:]$/.test(t)) return false;
  if (/[a-z]/.test(t)) return false;
  return /[A-Z]/.test(t);
}

/** A date range at the end of a line: "Aug 2025 - Present", "Jan 2020 - Dec 2021". */
const DATE_TAIL =
  /\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:present|current|now|((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2})\s*$/i;

const MONTH_TAIL = /(^|\s)((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?)\s*$/i;

/**
 * An employer or institution line, split into who and when.
 *
 * A resume puts the company at the left margin and the dates at the right, on one
 * line. Plain text can only run them together, so they are pulled apart again on
 * the date range — the same signal the resume parser uses to recognise the line.
 */
export function splitDates(line: string): { who: string; when: string } | null {
  const m = DATE_TAIL.exec(line);
  if (!m || m.index === 0) return null;

  // The month in front of the year is optional in the pattern, so on a bare
  // "Aug 2016 - Sep 2020" the match can begin at the year and leave "Aug" behind
  // as the company — which is how a date line becomes a bold employer called
  // August. If what is left ends in a month name, the split was made inside the
  // date and has to move back in front of it.
  let at = m.index;
  const month = MONTH_TAIL.exec(line.slice(0, at));
  if (month) at = month.index + month[1]!.length;

  const who = line.slice(0, at).replace(/[\s,•·|]+$/, '').trim();
  return who ? { who, when: line.slice(at).trim() } : null;
}

/** The bullet marker a line carries, and the text after it. */
const BULLET = /^\s*([•·‣▪●*-])\s+(.*)$/;

/** Contact details: recognised by what they contain, not by where they sit. */
function looksLikeContact(line: string): boolean {
  return /@|https?:|www\.|linkedin|github|\+\d|\(\d{3}\)|\d{3}[.-]\d{3}[.-]\d{4}/i.test(line);
}

export type Section = 'top' | 'skills' | 'experience' | 'education' | 'other';

export function sectionOf(heading: string): Section {
  const t = heading.toLowerCase();
  if (/skill|technolog|competenc|proficien/.test(t)) return 'skills';
  if (/experience|employment|work history|projects?/.test(t)) return 'experience';
  if (/education|academic|qualification|certification/.test(t)) return 'education';
  return 'other';
}

export type LineKind =
  | 'blank'
  | 'name'
  | 'contact'
  | 'heading'
  | 'employer'
  | 'role'
  | 'skill'
  | 'bullet'
  | 'body';

export interface LaidOutLine {
  kind: LineKind;
  /** The text to render. For an employer this is the company; for a skill, the whole line. */
  text: string;
  /** Employer only: the dates, which sit at the right margin. */
  when?: string;
  /** Skill only: the label up to and including the colon, which is bold. */
  label?: string;
  /** Skill only: the list after the label, which is not. */
  rest?: string;
  /** Which section the line falls in, for a renderer that wants to know. */
  section: Section;
}

/**
 * A resume, line by line, with each line's kind.
 *
 * The only input is the text, because the text is all that survives tailoring —
 * so the structure has to be recovered rather than remembered.
 */
export function layoutResume(resumeText: string): LaidOutLine[] {
  const lines = resumeText.replace(/\r\n?/g, '\n').split('\n');
  const firstReal = lines.findIndex((l) => l.trim().length > 0);

  let section: Section = 'top';
  /** True on the line straight after an employer, which is the role. */
  let expectRole = false;
  const out: LaidOutLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\s+$/, '');
    const t = raw.trim();

    if (!t) {
      out.push({ kind: 'blank', text: '', section });
      expectRole = false;
      continue;
    }

    // The name: the one line of a resume that is always a heading whatever it says.
    if (i === firstReal) {
      out.push({ kind: 'name', text: t, section });
      continue;
    }

    // Contact details, while still at the top. Further down, a line with a URL in
    // it is a bullet about a project.
    if (section === 'top' && looksLikeContact(t)) {
      out.push({ kind: 'contact', text: t, section });
      continue;
    }

    if (looksLikeHeading(t)) {
      section = sectionOf(t);
      expectRole = false;
      out.push({ kind: 'heading', text: t, section });
      continue;
    }

    const bullet = BULLET.exec(raw);
    if (bullet) {
      out.push({ kind: 'bullet', text: bullet[2]!.trim(), section });
      expectRole = false;
      continue;
    }

    if (section === 'experience' || section === 'education') {
      const split = splitDates(t);
      if (split) {
        out.push({ kind: 'employer', text: split.who, when: split.when, section });
        expectRole = true;
        continue;
      }
      if (expectRole) {
        out.push({ kind: 'role', text: t, section });
        expectRole = false;
        continue;
      }
    }

    if (section === 'skills') {
      // "Programming Languages and Scripting: ASP.NET, C#, SQL" — the label is
      // bold in every resume that has one, and it is what makes the section
      // skimmable. The colon is the whole signal.
      const at = t.indexOf(':');
      if (at > 0 && at <= 60) {
        out.push({
          kind: 'skill',
          text: t,
          label: t.slice(0, at + 1),
          rest: t.slice(at + 1),
          section,
        });
        continue;
      }
    }

    // Anything else, with its leading indentation intact — a sub-point indented
    // under a bullet is a sub-point, and flattening it changes what it says.
    out.push({ kind: 'body', text: raw, section });
  }

  return out;
}
