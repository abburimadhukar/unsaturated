/**
 * A profile, read out of a résumé — so nobody has to type their own CV into a
 * form to get forms filled.
 *
 * WHAT IT READS
 *
 *   details     name, email, phone, LinkedIn, GitHub, website, city/region/country,
 *               current company and title
 *   experience  every job: company, title, location, start, end
 *   education   every school: school, degree, discipline, dates, GPA
 *   skills      the skills section, as a list
 *   answers     years of experience (counted from the jobs), highest
 *               qualification, languages, currently employed
 *
 * EVERYTHING HERE IS READ, NOTHING IS MADE UP
 *
 * Each value is text that is on the résumé, or arithmetic on dates that are. A
 * value that cannot be found is left out, never guessed: an empty box the person
 * fills in is better than a confident wrong one filled in their name. The two
 * worked-out values — years of experience and "currently employed" — say how they
 * were worked out in `notes`, and the options page shows every value it took
 * from here highlighted until the person has looked at it.
 *
 * SHAPE, NOT VOCABULARY
 *
 * Résumés have no schema. The signals used are the ones nearly every résumé
 * shares: a date range on a job line, a section heading, a contact line near the
 * top. Words are used only to tell a job title from a company ("Engineer",
 * "Manager") and a degree from a school ("Bachelor", "University"), where there
 * is no other way to tell them apart.
 *
 * Pure: text in, object out. The extension's options page calls it on the text
 * pdf.js or the .docx reader produced, and tests/resume-profile.test.ts calls it
 * on résumés written out as text.
 */

export interface ResumeJob {
  company: string;
  title: string;
  location: string;
  /** "2021-03", or "2021" when the résumé gives only a year. */
  start: string;
  /** Same shape; empty when current. */
  end: string;
  current: boolean;
  /** The lines written under the job (its bullets), joined with newlines. */
  description?: string;
}

export interface ResumeSchool {
  school: string;
  degree: string;
  discipline: string;
  start: string;
  end: string;
  gpa: string;
}

export type DetailKey =
  | 'firstName'
  | 'middleName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'linkedin'
  | 'github'
  | 'website'
  | 'city'
  | 'region'
  | 'country'
  | 'currentCompany'
  | 'currentTitle';

export type ResumeAnswerKey = 'yearsExperience' | 'education' | 'languages' | 'currentlyEmployed';

export interface ResumeProfile {
  details: Partial<Record<DetailKey, string>>;
  answers: Partial<Record<ResumeAnswerKey, string>>;
  experience: ResumeJob[];
  education: ResumeSchool[];
  skills: string[];
  /** How the worked-out values were worked out, in words for the person. */
  notes: string[];
}

export interface ReadOptions {
  /** Link targets the PDF carried as annotations — a "LinkedIn" word whose URL is hidden. */
  links?: string[];
  /** For counting "Present" in years of experience. */
  today?: Date;
}

// ---------------------------------------------------------------------------
// Lines and sections
// ---------------------------------------------------------------------------

type Section = 'top' | 'experience' | 'education' | 'skills' | 'languages' | 'other';

/**
 * Bullet markers, including the private-use glyphs Word's Symbol font leaves in
 * a PDF (U+F0B7 is the round bullet, U+F0A7 the square one).
 */
const BULLET = /^\s*(?:[•·‣▪●○◦■□►▸✓✔*–—-]|[\uf000-\uf8ff])\s*/;

const SECTION_WORDS: [RegExp, Section][] = [
  [/^(work |professional |relevant |employment |career )?(experience|employment( history)?|work history|career history|professional background)$/i, 'experience'],
  [/^(education|academic (background|qualifications|history)|education (and|&) (training|qualifications|certifications)|qualifications)$/i, 'education'],
  [/^(technical |core |key )?(skills|competencies|technologies|tech stack|skills (and|&) (tools|technologies|expertise|interests)|tools( (and|&) technologies)?|expertise)$/i, 'skills'],
  [/^languages?( spoken)?$/i, 'languages'],
  [/^(projects|personal projects|certifications?|licen[cs]es( (and|&) certifications)?|summary|professional summary|profile|objective|about( me)?|awards|honou?rs|achievements|publications|interests|hobbies|volunteer(ing)?( experience)?|references|activities|leadership|courses|training)$/i, 'other'],
];

/** A line that names a section — "EXPERIENCE", "Skills" — as opposed to one merely in capitals. */
function knownHeading(line: string): boolean {
  const t = line.trim().replace(/[:：]$/, '').trim();
  return SECTION_WORDS.some(([re]) => re.test(t));
}

/** What a heading line announces, or null when the line is not a heading. */
function headingOf(line: string): Section | null {
  const t = line.trim().replace(/[:：]$/, '').trim();
  if (!t || t.length > 48) return null;
  if (/[.,;!?]$/.test(t)) return null;
  if (DATE_RANGE.test(t)) return null;
  for (const [re, section] of SECTION_WORDS) if (re.test(t)) return section;
  // An all-capitals line that names no known section still ENDS the one before
  // it — "VOLUNTEERING" must not be read as more jobs.
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && t === t.toUpperCase() && t.split(/\s+/).length <= 5) return 'other';
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const YEAR = '(?:19|20)\\d{2}';
const DATE_TOKEN = `(?:${MONTH}\\s*[',]?\\s*${YEAR}|\\d{1,2}\\s*[/.-]\\s*${YEAR}|${YEAR}\\s*[/.-]\\s*\\d{1,2}(?!\\d)|${YEAR})`;
const DATE_END = `(?:${DATE_TOKEN}|present|current|now|today|ongoing|date)`;
const DATE_RANGE = new RegExp(`(${DATE_TOKEN})\\s*(?:-|–|—|to|until|through|till)\\s*(${DATE_END})`, 'i');

interface YearMonth {
  y: number;
  /** 1–12, or 0 when the résumé gave only a year. */
  m: number;
}

function parseDate(token: string): YearMonth | null {
  const t = token.trim().toLowerCase();
  let m = new RegExp(`^(${MONTH})\\s*[',]?\\s*(${YEAR})$`, 'i').exec(t);
  if (m) return { y: Number(m[2]), m: MONTH_NAMES.indexOf(m[1]!.slice(0, 3)) + 1 };
  m = new RegExp(`^(\\d{1,2})\\s*[/.-]\\s*(${YEAR})$`).exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { y: Number(m[2]), m: Number(m[1]) };
  m = new RegExp(`^(${YEAR})\\s*[/.-]\\s*(\\d{1,2})$`).exec(t);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { y: Number(m[1]), m: Number(m[2]) };
  m = new RegExp(`^(${YEAR})$`).exec(t);
  if (m) return { y: Number(m[1]), m: 0 };
  return null;
}

const isOngoing = (token: string) => /^(present|current|now|today|ongoing|date)$/i.test(token.trim());

/** Back from the stored "2021-03" / "2021". */
function fromStored(s: string): YearMonth | null {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(s.trim());
  return m ? { y: Number(m[1]), m: m[2] ? Number(m[2]) : 0 } : null;
}

function formatDate(d: YearMonth | null): string {
  if (!d) return '';
  return d.m ? `${d.y}-${String(d.m).padStart(2, '0')}` : String(d.y);
}

// ---------------------------------------------------------------------------
// Words that tell parts apart
// ---------------------------------------------------------------------------

/**
 * Job-title words. The only way to tell "Senior Data Engineer" from "Acme
 * Analytics" on a line that holds both. Broad on purpose — a nurse, a teacher
 * and an accountant have titles too.
 */
const TITLE_WORDS = /\b(engineer|developer|programmer|architect|manager|director|lead|head|analyst|scientist|designer|consultant|specialist|intern|internship|associate|assistant|coordinator|administrator|officer|executive|president|vp|founder|co-?founder|owner|partner|technician|representative|advisor|adviser|strategist|researcher|fellow|trainee|apprentice|editor|writer|producer|accountant|auditor|nurse|teacher|lecturer|professor|instructor|tutor|recruiter|sales|marketing|operator|supervisor|agent|clerk|cashier|chef|driver|attorney|lawyer|paralegal|physician|therapist|pharmacist|product owner|scrum master|sre|devops|qa|tester|cto|ceo|cfo|coo|cio|member of technical staff|staff|principal|contractor|freelancer?|volunteer)\b/i;

const COMPANY_HINT = /\b(inc|llc|ltd|limited|corp|corporation|company|co\.|gmbh|ag|plc|pvt|private|technologies|technology|solutions|systems|labs|software|consulting|services|group|holdings|bank|capital|partners|studio|studios|agency|media|health|hospital|university|foundation|institute)\b/i;

const SCHOOL_WORDS = /\b(university|universit[äa]t|universidad|universit[ée]|college|institute|institut|school|academy|polytechnic|conservatory|iit|nit|iiit|bits|mit|ucla|nyu|lse)\b/i;

/**
 * Degree words, most specific first; `rank` orders them for "highest
 * qualification". Abbreviations are matched in CAPITALS only: "BE", "MA", "MS"
 * and "AS" are degrees, but "be", "ma", "ms" and "as" are ordinary words.
 */
const DEGREES: { words: RegExp; abbr: RegExp; rank: number }[] = [
  { words: /\b(ph\.?\s?d|doctor(ate)? of|doctorate|d\.?phil)\b/i, abbr: /\b(PhD|Ph\.D\.?|DPhil|EdD|MD|JD)\b/, rank: 6 },
  { words: /\b(m\.?b\.?a|master of business administration)\b/i, abbr: /\bMBA\b/, rank: 5 },
  { words: /\b(master'?s?|m\.?sc|m\.?tech|m\.?eng|m\.?phil|m\.?com|ll\.?m|m\.?res)\b/i, abbr: /\b(M\.?S\.?|M\.?A\.?|M\.?E\.?|MCA|M\.?Ed|MPH|MFA|MIS)\b/, rank: 4 },
  { words: /\b(bachelor'?s?|b\.?sc|b\.?tech|b\.?eng|b\.?com|ll\.?b|b\.?arch|undergraduate degree)\b/i, abbr: /\b(B\.?S\.?|B\.?A\.?|B\.?E\.?|BCA|BBA|B\.?Ed|BFA|A\.?B\.?)\b/, rank: 3 },
  { words: /\bassociate'?s?( degree| of)\b/i, abbr: /\b(A\.?A\.?S?|A\.?S\.?)\b/, rank: 2 },
  { words: /\b(diploma|certificate|hnd|hnc|foundation degree)\b/i, abbr: /(?!)/, rank: 1 },
  { words: /\b(high school|secondary school|a[- ]levels?|gcse|ssc|hsc|12th|10th)\b/i, abbr: /(?!)/, rank: 0 },
];

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

const CA_PROVINCE_NAMES: Record<string, string> = {
  ON: 'Ontario', QC: 'Quebec', BC: 'British Columbia', AB: 'Alberta', MB: 'Manitoba', SK: 'Saskatchewan',
  NS: 'Nova Scotia', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island',
  YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut',
};

const CA_PROVINCES = /^(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU|Ontario|Quebec|British Columbia|Alberta|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland( and Labrador)?|Prince Edward Island)$/i;

const COUNTRIES = /^(united states( of america)?|usa|us|u\.s\.a?\.?|united kingdom|uk|u\.k\.|england|scotland|wales|ireland|canada|india|germany|france|spain|portugal|italy|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|czech republic|czechia|romania|hungary|greece|turkey|israel|uae|united arab emirates|saudi arabia|qatar|egypt|nigeria|kenya|south africa|ghana|australia|new zealand|singapore|malaysia|indonesia|philippines|vietnam|thailand|japan|south korea|korea|china|hong kong|taiwan|pakistan|bangladesh|sri lanka|nepal|brazil|mexico|argentina|chile|colombia|peru|uruguay|estonia|latvia|lithuania|ukraine|luxembourg|iceland|cyprus|malta)$/i;

const COUNTRY_NAME: Record<string, string> = {
  usa: 'United States', us: 'United States', 'u.s.a.': 'United States', 'u.s.a': 'United States', 'u.s.': 'United States',
  'united states of america': 'United States', uk: 'United Kingdom', 'u.k.': 'United Kingdom', uae: 'United Arab Emirates',
};

// ---------------------------------------------------------------------------

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripEdges = (s: string) => clean(s).replace(/^[\s,|·•–—:-]+|[\s,|·•–—:-]+$/g, '').trim();

function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase());
}

/** The parts of a line, split on the separators résumés use between who/what/where. */
function partsOf(line: string): string[] {
  return line
    .split(/\s+[|·•]\s+|\s[–—]\s|\s-\s|\s{3,}|\t|\s+@\s+|\s+at\s+(?=[A-Z])/)
    .map(stripEdges)
    .filter(Boolean)
    .flatMap(splitCommas);
}

/**
 * A comma is a separator only where it separates different KINDS of thing.
 *
 * "Engineer, Tailspin Toys" is a title and a company; "Contoso Retail, Toronto,
 * ON" is a company and a place; but "Toronto, ON" is one place and "Fabrikam,
 * Inc." one company, and neither may be cut in half.
 */
function splitCommas(part: string): string[] {
  if (!part.includes(',') || looksLikePlace(part)) return [part];
  const bits = part.split(/\s*,\s*/).filter(Boolean);
  for (let i = 1; i < bits.length; i++) {
    const tail = bits.slice(i).join(', ');
    if (looksLikePlace(tail)) return [...splitCommas(bits.slice(0, i).join(', ')), tail];
  }
  const head = bits[0]!;
  const rest = bits.slice(1).join(', ');
  if (/^(inc|llc|ltd|co|corp|gmbh|plc)\.?$/i.test(rest)) return [part];
  if (TITLE_WORDS.test(head) !== TITLE_WORDS.test(rest)) return [head, rest];
  if ((degreeRank(head) >= 0) !== (degreeRank(rest) >= 0) || SCHOOL_WORDS.test(head) !== SCHOOL_WORDS.test(rest)) {
    return [head, rest];
  }
  return [part];
}

/** "Toronto, ON", "London, United Kingdom", "Remote". */
function looksLikePlace(s: string): boolean {
  const t = s.trim();
  if (/^(remote|hybrid|on-?site)$/i.test(t)) return true;
  if (/\d|@|https?:|www\./i.test(t)) return false;
  const bits = t.split(/\s*,\s*/);
  if (bits.length < 2 || bits.length > 3) return COUNTRIES.test(t);
  const last = bits[bits.length - 1]!;
  // Three parts is city, region, COUNTRY. "Contoso Retail, Toronto, ON" ends in
  // a province, so it is a company and a two-part place, not one place.
  if (bits.length === 3) return COUNTRIES.test(last);
  return /^[A-Z]{2}$/.test(last) || COUNTRIES.test(last) || CA_PROVINCES.test(last) || Object.values(US_STATES).some((n) => n.toLowerCase() === last.toLowerCase());
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function findPhone(text: string): string {
  const candidates = text.match(/(?:\+\s?)?\(?\d[\d\s().-]{6,}\d/g) ?? [];
  for (const raw of candidates) {
    const c = raw.trim();
    // Dates are the thing a phone pattern most often catches: "01/2019 - 12/2021",
    // "2018 - 2022". A slash, or every digit group being a year, rules it out.
    if (/\//.test(c)) continue;
    const groups = c.match(/\d+/g) ?? [];
    if (groups.every((g) => /^(19|20)\d{2}$/.test(g))) continue;
    const digits = c.replace(/\D/g, '');
    const plus = c.startsWith('+');
    if (digits.length > 15) continue;
    if (digits.length >= 10 || (plus && digits.length >= 8)) return clean(c);
  }
  return '';
}

function normaliseUrl(u: string): string {
  const t = u.trim().replace(/[),.;]+$/, '');
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function findLinkedin(hay: string): string {
  const m = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]+)/i.exec(hay);
  return m ? `https://www.linkedin.com/in/${m[1]}` : '';
}

function findGithub(hay: string): string {
  const m = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9-])/i.exec(hay);
  if (!m || /^(orgs|topics|features|about|pricing|login)$/i.test(m[1]!)) return '';
  return `https://github.com/${m[1]}`;
}

const SITE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|dev|io|me|net|org|co|app|ai|tech|site|xyz|info|design|page|blog|codes|portfolio|online)(?:\/[^\s|,)]*)?/gi;

function findWebsite(topText: string, links: string[]): string {
  const skip = /linkedin\.com|github\.com|mailto:|tel:|google\.com|gmail\.com|outlook\.com|yahoo\.com|hotmail\.com|icloud\.com/i;
  for (const l of links) if (/^https?:\/\//i.test(l) && !skip.test(l)) return l.replace(/\/$/, '');
  const noEmails = topText.replace(new RegExp(EMAIL.source, 'gi'), ' ');
  for (const m of noEmails.match(SITE) ?? []) {
    if (!skip.test(m)) return normaliseUrl(m).replace(/\/$/, '');
  }
  return '';
}

function findPlace(lines: string[], name: string): { city: string; region: string; country: string } | null {
  for (const line of lines) {
    for (const part of line.split(/\s*[|·•]\s*|\s{2,}|\s[–—-]\s/).map(stripEdges)) {
      if (!part || part === name || EMAIL.test(part) || TITLE_WORDS.test(part)) continue;
      if (/^(remote|hybrid)$/i.test(part)) continue;
      if (!looksLikePlace(part)) continue;
      const bits = part.split(/\s*,\s*/).map((b) => b.trim());
      if (bits.length === 1) return { city: '', region: '', country: countryName(bits[0]!) };
      const [city, second, third] = bits as [string, string, string?];
      if (third) return { city, region: second, country: countryName(third) };
      // Codes are spelled out. Greenhouse's place picker finds nothing for
      // "Toronto, ON, Canada" and finds "Toronto, Ontario, Canada" at once, and
      // US state menus list "Texas", not "TX". Same place, the words forms use.
      if (/^[A-Z]{2}$/.test(second) && US_STATES[second]) return { city, region: US_STATES[second]!, country: 'United States' };
      if (CA_PROVINCES.test(second)) return { city, region: CA_PROVINCE_NAMES[second.toUpperCase()] ?? second, country: 'Canada' };
      if (COUNTRIES.test(second)) return { city, region: '', country: countryName(second) };
      return { city, region: second, country: '' };
    }
  }
  return null;
}

function countryName(s: string): string {
  return COUNTRY_NAME[s.toLowerCase()] ?? titleCase(s);
}

function findName(lines: string[]): string {
  for (const raw of lines.slice(0, 5)) {
    const first = stripEdges(raw.split(/\s*[|·•]\s*|\s{2,}/)[0] ?? '');
    if (!first) continue;
    if (/^(resume|résumé|curriculum vitae|cv)$/i.test(first)) continue;
    if (/[\d@/:]/.test(first)) continue;
    const words = first.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[\p{L}][\p{L}.'-]*$/u.test(w))) continue;
    if (knownHeading(first)) continue;
    return titleCase(first);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

function isBullet(line: string): boolean {
  return BULLET.test(line) && !/^\s*-?\d/.test(line);
}

/** Short enough, and shaped like a label rather than a sentence about work done. */
function headerLike(line: string): boolean {
  const t = line.trim();
  if (!t || isBullet(t) || t.length > 90) return false;
  if (/[.;]$/.test(t) && !/\b(inc|ltd|co|corp)\.$/i.test(t)) return false;
  return t.split(/\s+/).length <= 12;
}

function readJobs(section: string[]): ResumeJob[] {
  const jobs: ResumeJob[] = [];
  const used = new Set<number>();
  // Where each job's heading starts and ends, so the lines between one job's
  // heading and the next are that job's description.
  const heads: { first: number; last: number }[] = [];

  for (let i = 0; i < section.length; i++) {
    const line = section[i]!;
    const range = DATE_RANGE.exec(line);
    if (!range) continue;
    // A date inside a bullet ("Led the 2021 - 2022 migration") is not a new job.
    if (isBullet(line) && line.replace(BULLET, '').length > 60) continue;

    const rest = stripEdges(line.slice(0, range.index) + ' ' + line.slice(range.index + range[0].length));
    const candidates: { text: string; from: 'same' | 'before' | 'after' }[] = [];
    for (const p of partsOf(rest)) candidates.push({ text: p, from: 'same' });

    // Up to two label lines above, stopping at a blank, a bullet, or a line an
    // earlier job has already claimed.
    let first = i;
    let last = i;
    for (let k = i - 1, taken = 0; k >= 0 && taken < 2; k--) {
      const prev = section[k]!;
      if (!prev.trim() || used.has(k) || !headerLike(prev) || DATE_RANGE.test(prev)) break;
      for (const p of partsOf(prev)) candidates.push({ text: p, from: 'before' });
      used.add(k);
      first = k;
      taken++;
    }
    // And up to two below, when the line with the dates did not say enough.
    const haveBoth = () => candidates.some((c) => TITLE_WORDS.test(c.text)) && candidates.some((c) => !TITLE_WORDS.test(c.text) && !looksLikePlace(c.text));
    for (let k = i + 1, taken = 0; k < section.length && taken < 2 && !haveBoth(); k++) {
      const next = section[k]!;
      if (!next.trim() || !headerLike(next) || DATE_RANGE.test(next)) break;
      for (const p of partsOf(next)) candidates.push({ text: p, from: 'after' });
      used.add(k);
      last = k;
      taken++;
    }
    used.add(i);

    const places = candidates.filter((c) => looksLikePlace(c.text));
    const others = candidates.filter((c) => !looksLikePlace(c.text));
    // "Software Engineer" holds a company word ("software") and a title word;
    // "Adatum Software" holds only the company word. So a title is anything
    // with a title word, preferring one with no company word, and a company is
    // anything WITHOUT a title word, preferring one with a company word.
    const titled = others.filter((c) => TITLE_WORDS.test(c.text));
    let title = (titled.find((c) => !COMPANY_HINT.test(c.text)) ?? titled[0])?.text ?? '';
    const untitled = others.filter((c) => c.text !== title && !TITLE_WORDS.test(c.text));
    let company = (untitled.find((c) => COMPANY_HINT.test(c.text)) ?? untitled[0])?.text ?? '';
    // Neither part has a title word: the usual layout is employer first, role
    // second, so read them in that order rather than guess.
    if (!title && !company && others.length >= 2) {
      company = others[0]!.text;
      title = others[1]!.text;
    } else if (!title && company) {
      title = others.find((c) => c.text !== company)?.text ?? '';
    } else if (title && !company) {
      company = others.find((c) => c.text !== title)?.text ?? '';
    }

    const start = parseDate(range[1]!);
    const ongoing = isOngoing(range[2]!);
    const end = ongoing ? null : parseDate(range[2]!);
    jobs.push({
      company: company.replace(/,\s*$/, ''),
      title,
      location: places[0]?.text ?? '',
      start: formatDate(start),
      end: formatDate(end),
      current: ongoing,
    });
    heads.push({ first, last });
  }
  // Each job's description: the lines after its heading, up to the next job's.
  jobs.forEach((job, j) => {
    const body = section.slice(heads[j]!.last + 1, heads[j + 1]?.first ?? section.length)
      .map((l) => l.replace(BULLET, '').trim())
      .filter((l) => l.length > 2);
    if (body.length) job.description = body.join('\n').slice(0, 2000);
  });
  return jobs.filter((j) => j.company || j.title);
}

/**
 * Whole years of experience, with overlapping jobs counted once.
 *
 * Deliberately rounded DOWN, and a year-only date counts from January to
 * January: over-stating experience is a claim made in the person's name, and
 * under-stating it by a few months is not.
 */
function yearsOf(jobs: ResumeJob[], today: Date): { years: number; from: string } | null {
  const spans: [number, number][] = [];
  for (const j of jobs) {
    const s = fromStored(j.start);
    if (!s) continue;
    const startM = s.y * 12 + (s.m ? s.m - 1 : 0);
    let endM: number;
    if (j.current) endM = today.getFullYear() * 12 + today.getMonth();
    else {
      const e = fromStored(j.end);
      if (!e) continue;
      endM = e.y * 12 + (e.m ? e.m - 1 : 0);
    }
    if (endM > startM) spans.push([startM, endM]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curS, curE] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s <= curE) curE = Math.max(curE, e);
    else {
      total += curE - curS;
      [curS, curE] = [s, e];
    }
  }
  total += curE - curS;
  const first = spans[0]![0];
  const from = `${MONTH_NAMES[first % 12]!.replace(/^./, (c) => c.toUpperCase())} ${Math.floor(first / 12)}`;
  return { years: Math.floor(total / 12), from };
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

function degreeRank(text: string): number {
  for (const d of DEGREES) if (d.words.test(text) || d.abbr.test(text)) return d.rank;
  return -1;
}

/**
 * "Master of Science in Computer Science" → degree + discipline.
 *
 * Four shapes: "… in X", "Degree (X)", "Degree, X" and "MA X" — an
 * abbreviation followed straight by the subject.
 */
function splitDegree(text: string): { degree: string; discipline: string } {
  const t = stripEdges(text);
  const inX = /^(.+?)\s+in\s+(.+)$/i.exec(t);
  if (inX && degreeRank(inX[1]!) >= 0) return { degree: stripEdges(inX[1]!), discipline: stripEdges(inX[2]!) };
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(t);
  if (paren && degreeRank(paren[1]!) >= 0 && !/^(hons|honours|honors)$/i.test(paren[2]!)) {
    return { degree: stripEdges(paren[1]!), discipline: stripEdges(paren[2]!) };
  }
  const comma = /^([^,]+?)\s*[,:–—]\s*(.+)$/.exec(t);
  if (comma && degreeRank(comma[1]!) >= 0 && degreeRank(comma[2]!) < 0) {
    return { degree: stripEdges(comma[1]!), discipline: stripEdges(comma[2]!) };
  }
  const abbr = /^(\S+(?:\s*\((?:hons|honours|honors)\))?)\s+(.+)$/i.exec(t);
  if (abbr && degreeRank(abbr[1]!) >= 0 && degreeRank(abbr[2]!) < 0 && !/^of\b/i.test(abbr[2]!)) {
    return { degree: stripEdges(abbr[1]!), discipline: stripEdges(abbr[2]!) };
  }
  return { degree: t, discipline: '' };
}

function readSchools(section: string[]): ResumeSchool[] {
  const schools: ResumeSchool[] = [];
  let cur: ResumeSchool | null = null;
  const fresh = (): ResumeSchool => ({ school: '', degree: '', discipline: '', start: '', end: '', gpa: '' });
  const flush = () => {
    if (cur && (cur.school || cur.degree)) schools.push(cur);
    cur = null;
  };

  for (const raw of section) {
    if (!raw.trim()) continue;
    const line = raw.replace(BULLET, '');
    let rest = line;

    let gpa = '';
    const g = /\b(?:c?gpa|grade point average|cgpa)\s*[:\-]?\s*(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)/i.exec(rest)
      ?? /\b(\d\.\d{1,2}\s*\/\s*(?:4|5|10)(?:\.0+)?)\b/.exec(rest);
    if (g) {
      gpa = g[1]!.replace(/\s+/g, '');
      rest = rest.replace(g[0], ' ');
    }

    let start = '';
    let end = '';
    const range = DATE_RANGE.exec(rest);
    if (range) {
      start = formatDate(parseDate(range[1]!));
      end = isOngoing(range[2]!) ? '' : formatDate(parseDate(range[2]!));
      rest = rest.replace(range[0], ' ');
    } else {
      const single = new RegExp(`(?:expected|graduat\\w*|class of|completed)?\\s*(${DATE_TOKEN})`, 'i').exec(rest);
      // A lone date in the education section is when that course finished.
      if (single) {
        end = formatDate(parseDate(single[1]!));
        rest = rest.replace(single[0], ' ');
      }
    }

    const parts = partsOf(rest);
    for (const part of parts.length ? parts : [stripEdges(rest)]) {
      if (!part) continue;
      const isSchool = SCHOOL_WORDS.test(part) && degreeRank(part) < 0;
      const isDegree = degreeRank(part) >= 0 && !(SCHOOL_WORDS.test(part) && /\b(school|college|university)\b/i.test(part) && degreeRank(part) === 0 && !/high school diploma/i.test(part));
      if (isSchool) {
        if (cur && (cur as ResumeSchool).school) flush();
        cur ??= fresh();
        (cur as ResumeSchool).school = part.replace(/,\s*[A-Z][a-z]+(,\s*[A-Z]{2,})?$/, '').trim();
      } else if (isDegree) {
        if (cur && (cur as ResumeSchool).degree) flush();
        cur ??= fresh();
        const d = splitDegree(part);
        (cur as ResumeSchool).degree = d.degree;
        (cur as ResumeSchool).discipline = d.discipline;
      }
    }
    if (cur) {
      const c = cur as ResumeSchool;
      if (gpa && !c.gpa) c.gpa = gpa;
      if (start && !c.start) c.start = start;
      if (end && !c.end) c.end = end;
    }
  }
  flush();
  return schools;
}

// ---------------------------------------------------------------------------
// Skills and languages
// ---------------------------------------------------------------------------

function readSkills(section: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of section) {
    const line = raw.replace(BULLET, '').trim();
    if (!line) continue;
    const body = line.includes(':') && line.indexOf(':') < 50 ? line.slice(line.indexOf(':') + 1) : line;
    for (const piece of body.split(/\s*[,|•·;]\s*|\s{2,}/)) {
      const s = stripEdges(piece).replace(/^(and|&)\s+/i, '');
      if (!s || s.length > 40 || s.split(/\s+/).length > 5) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      if (out.length >= 60) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export function profileFromResume(text: string, opts: ReadOptions = {}): ResumeProfile {
  const today = opts.today ?? new Date();
  const links = (opts.links ?? []).map((l) => l.trim()).filter(Boolean);
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));

  const sections: Record<Section, string[]> = { top: [], experience: [], education: [], skills: [], languages: [], other: [] };
  let current: Section = 'top';
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading && (current !== 'top' || sections.top.some((l) => l.trim()))) {
      current = heading;
      continue;
    }
    sections[current].push(line);
  }

  // A résumé with no headings at all is still worth reading for contact details
  // and jobs; treat the whole thing as one section for each.
  const noHeadings = !sections.experience.length && !sections.education.length;
  const jobLines = noHeadings ? lines : sections.experience;

  const profile: ResumeProfile = { details: {}, answers: {}, experience: [], education: [], skills: [], notes: [] };
  const d = profile.details;
  const topLines = sections.top.filter((l) => l.trim()).slice(0, 12);
  const topText = topLines.join('\n');
  const everything = `${text}\n${links.join('\n')}`;

  const name = findName(topLines.length ? topLines : lines.filter((l) => l.trim()));
  if (name) {
    const words = name.split(/\s+/);
    d.firstName = words[0]!;
    d.lastName = words[words.length - 1]!;
    if (words.length > 2) d.middleName = words.slice(1, -1).join(' ');
  }

  const email = EMAIL.exec(everything.replace(/mailto:/gi, ' '));
  if (email) d.email = email[0];
  const phone = findPhone(topText) || findPhone(text.split('\n').slice(0, 30).join('\n'));
  if (phone) d.phone = phone;
  const linkedin = findLinkedin(everything);
  if (linkedin) d.linkedin = linkedin;
  const github = findGithub(everything);
  if (github) d.github = github;
  const website = findWebsite(topText, links);
  if (website) d.website = website;
  const place = findPlace(topLines, name);
  if (place) {
    if (place.city) d.city = place.city;
    if (place.region) d.region = place.region;
    if (place.country) d.country = place.country;
  }

  profile.experience = readJobs(jobLines);
  profile.education = readSchools(sections.education);
  profile.skills = readSkills(sections.skills);

  const latest = profile.experience.find((j) => j.current) ?? profile.experience[0];
  if (latest) {
    if (latest.company) d.currentCompany = latest.company;
    if (latest.title) d.currentTitle = latest.title;
  }
  if (profile.experience.some((j) => j.current)) {
    profile.answers.currentlyEmployed = 'Yes';
    profile.notes.push(`Currently employed: yes, because ${latest?.company || 'a job'} runs to "Present".`);
  }

  const years = yearsOf(profile.experience, today);
  if (years) {
    profile.answers.yearsExperience = String(years.years);
    profile.notes.push(
      `Years of experience: ${years.years}, counted from ${profile.experience.length} job${profile.experience.length === 1 ? '' : 's'} starting ${years.from}. Overlapping jobs count once, and it is rounded down. Change it if you count differently.`,
    );
  }

  const best = [...profile.education].sort((a, b) => degreeRank(b.degree) - degreeRank(a.degree))[0];
  if (best && (best.degree || best.school)) {
    profile.answers.education = [
      [best.degree, best.discipline].filter(Boolean).join(' in '),
      best.school,
      best.end.slice(0, 4),
    ].filter(Boolean).join(', ');
  }

  const spoken = sections.languages.map((l) => l.replace(BULLET, '').trim()).filter(Boolean);
  const inSkills = sections.skills.map((l) => /^\s*(spoken )?languages?\s*:\s*(.+)$/i.exec(l.replace(BULLET, ''))?.[2]).find(Boolean);
  const languages = spoken.length ? spoken.join(', ') : inSkills ?? '';
  if (languages && !/\b(python|java|javascript|typescript|c\+\+|sql|golang|rust|ruby|php)\b/i.test(languages)) {
    profile.answers.languages = clean(languages);
  }

  return profile;
}
