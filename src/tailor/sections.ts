/**
 * A resume as its parts, so a rewrite can be checked employer by employer.
 *
 * WHY THIS IS NEEDED FOR A WHOLE-DOCUMENT REWRITE
 *
 * The line-by-line version could check a claim against the resume as a whole,
 * because every edit named the exact line it replaced and that line was already
 * proven to be in the document. A rewrite has no such anchor: it produces new
 * bullets under each employer, and "is Kubernetes in the resume?" is the wrong
 * question. Kubernetes at Life Bonder is not Kubernetes at Infosys, and a
 * rewrite that moves it between them has invented a work history while passing
 * every whole-document check.
 *
 * So the resume is split by employer, and a bullet written under an employer may
 * only draw on the lines that were already under that employer.
 *
 * HEURISTIC, AND HONEST ABOUT IT
 *
 * Resumes have no schema. This reads the shapes people actually use — a heading
 * in capitals, a line carrying a date range, a role line under it — and anything
 * it cannot place goes to `loose` rather than being attached to whichever
 * employer happened to be last. A bullet filed under the wrong company is worse
 * than a bullet filed nowhere, because the wrong filing licenses a claim.
 */

export interface Company {
  /** Stable within one parse, used to tie a rewritten bullet to its source. */
  id: string;
  /** The header line as written, e.g. "LIFE BONDER, United States Feb 2024 - Present". */
  header: string;
  /** Best guess at the employer's name, for showing and for matching. */
  name: string;
  /** The role line, when there is one under the header. */
  role: string;
  /** Everything said about this job, as written. */
  bullets: string[];
  /** Line indexes in the original text, so an edit can point at one. */
  lines: number[];
}

export interface ResumeShape {
  name: string;
  contact: string[];
  summary: string[];
  skills: string[];
  education: string[];
  companies: Company[];
  /** Lines that could not be placed. Kept, never guessed at. */
  loose: string[];
}

/**
 * A section heading: short, mostly capitals, no sentence punctuation.
 *
 * A DATE RANGE DISQUALIFIES IT, and that is not a detail.
 *
 * "SOUTHEAST MISSOURI STATE UNIVERSITY Aug 2022 - Dec 2023" is all capitals and
 * looks exactly like a heading. Read as one it matched no known section, which
 * cleared the EDUCATION context — so the degree under it was filed as an
 * unplaceable line and the next university was filed as an EMPLOYER. Somebody's
 * school became a job.
 *
 * Section headings do not carry dates. Testing that here rather than ordering the
 * two checks in the caller, so the predicate is true on its own and cannot be
 * broken by someone rearranging the loop.
 */
export function isSectionHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  if (/[.;]$/.test(t)) return false;
  if (isCompanyHeader(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  const caps = t.replace(/[^A-Z]/g, '').length;
  return caps / letters.length > 0.8;
}

const MONTHS =
  '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

/**
 * A line that announces a job.
 *
 * The signal is a DATE RANGE, because that is the one thing every resume puts on
 * an employer line and almost nothing else has. "Feb 2024 - Present", "2019-2021",
 * "Jan 2020 to Dec 2021".
 */
export function isCompanyHeader(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 160) return false;
  const range = new RegExp(
    `(${MONTHS}\\s+)?(19|20)\\d{2}\\s*(-|–|—|to|until)\\s*((${MONTHS}\\s+)?(19|20)\\d{2}|present|current|now)`,
    'i',
  );
  return range.test(t);
}

/** The employer's name out of a header line: what comes before the comma or the date. */
export function companyName(header: string): string {
  const beforeDate = header.split(
    new RegExp(`\\s*(${MONTHS}\\s+)?(19|20)\\d{2}\\s*(-|–|—|to)`, 'i'),
  )[0] ?? header;
  const first = beforeDate.split(/[,|·•]/)[0] ?? beforeDate;
  return first.trim().replace(/\s+/g, ' ');
}

const SECTION_OF: [RegExp, keyof ResumeShape][] = [
  [/\b(technical\s+)?skills?\b|\btechnolog(y|ies)\b|\bcompetenc/i, 'skills'],
  [/\bexperience\b|\bemployment\b|\bwork history\b/i, 'companies'],
  [/\beducation\b|\bacademic\b|\bqualifications?\b/i, 'education'],
  [/\bsummary\b|\bprofile\b|\bobjective\b|\babout\b/i, 'summary'],
];

function sectionFor(heading: string): keyof ResumeShape | null {
  for (const [re, key] of SECTION_OF) if (re.test(heading)) return key;
  return null;
}

/** Contact details: recognised by what they contain, not by where they sit. */
function looksLikeContact(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 140) return false;
  return (
    /@[\w.-]+\.\w{2,}/.test(t) ||
    /\+?\d[\d\s()-]{7,}/.test(t) ||
    /\b(linkedin|github|gitlab)\b/i.test(t)
  );
}

/**
 * The resume, split into its parts.
 *
 * Every original line ends up somewhere — in a section, under a company, or in
 * `loose`. Nothing is dropped, because a rewrite that silently loses a line has
 * shortened somebody's CV without telling them.
 */
export function readShape(text: string): ResumeShape {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const shape: ResumeShape = {
    name: '',
    contact: [],
    summary: [],
    skills: [],
    education: [],
    companies: [],
    loose: [],
  };

  let current: keyof ResumeShape | null = null;
  let company: Company | null = null;
  let seenName = false;
  let n = 0;

  const push = (key: keyof ResumeShape | null, line: string) => {
    if (key === 'skills' || key === 'summary' || key === 'education') shape[key].push(line);
    else shape.loose.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (!t) continue;

    if (!seenName) {
      shape.name = t;
      seenName = true;
      continue;
    }

    if (isSectionHeading(t)) {
      current = sectionFor(t);
      company = null;
      continue;
    }

    if (shape.contact.length < 3 && !current && looksLikeContact(t)) {
      shape.contact.push(t);
      continue;
    }

    if (isCompanyHeader(t)) {
      company = {
        id: `c${++n}`,
        header: t,
        name: companyName(t),
        role: '',
        bullets: [],
        lines: [i],
      };
      shape.companies.push(company);
      // A date range inside the education block belongs to a school, not a job.
      if (current === 'education') {
        shape.companies.pop();
        company = null;
        shape.education.push(t);
      }
      continue;
    }

    if (company) {
      // The first line under an employer, if it is short and has no sentence
      // end, is the job title rather than a thing that was done.
      if (!company.role && company.bullets.length === 0 && t.length < 80 && !/[.;]$/.test(t)) {
        company.role = t;
      } else {
        company.bullets.push(t);
      }
      company.lines.push(i);
      continue;
    }

    // Anything after the contact block and before the first section heading is
    // the summary. Keyed on POSITION and not on length: an earlier version
    // required 80 characters, so "Full Stack .NET engineer with 6 years of
    // experience." — a perfectly ordinary short summary — fell through to
    // `loose` and was then missing from the rewritten document entirely.
    if (!current && !company) {
      shape.summary.push(t);
      continue;
    }

    push(current, t);
  }

  return shape;
}

/**
 * Everything the resume says about one employer, as one block.
 *
 * What a rewritten bullet for that employer is checked against — and the only
 * thing it is checked against, which is the point.
 */
export function evidenceFor(company: Company): string {
  return [company.header, company.role, ...company.bullets].filter(Boolean).join('\n');
}
