import type { RemoteType } from './types.js';

const ENTITIES: Record<string, string> = {
  // Punctuation Greenhouse and Ashby emit constantly. Without these, raw
  // "&mdash;" and "&rsquo;" tokens ended up inside descriptionText, which is
  // what the classifier, salary parser and seniority reader all match against.
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
  middot: '·', deg: '°', trade: '™', reg: '®', copy: '©',
  eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö',
  auml: 'ä', szlig: 'ß',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
};

/**
 * Greenhouse double-encodes its `content` field (&amp;lt;p&amp;gt;), so decoding
 * has to run until it stops changing rather than exactly once.
 */
export function decodeEntities(input: string, passes = 3): string {
  let out = input;
  for (let pass = 0; pass < passes; pass++) {
    const next = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
      const known = ENTITIES[name];
      if (known !== undefined) return known;
      if (name.startsWith('#x') || name.startsWith('#X')) {
        const code = Number.parseInt(name.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (name.startsWith('#')) {
        const code = Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Escaped markup, as opposed to a literal "&lt;" in the prose. */
const ESCAPED_TAG =
  /&(amp;)*lt;\s*\/?(p|div|br|li|ul|ol|h[1-6]|span|strong|em|a|b|i|u|table|tbody|thead|tr|td|th|section|article|blockquote|pre|code|hr|img|figure|small)\b/i;

export function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;

  // Unescape only while the text still looks like escaped MARKUP.
  //
  // Decoding unconditionally first — as this used to — turned a literal
  // "C&lt;T&gt;" or "Salary &lt; 100k &gt; market" in the prose into a tag, and
  // the tag stripper then deleted everything between the brackets. Whole spans
  // of description text vanished, and that text is what the classifier, the
  // salary parser and the seniority reader all read.
  let markup = html;
  for (let pass = 0; pass < 3 && ESCAPED_TAG.test(markup); pass++) {
    markup = decodeEntities(markup, 1);
  }

  const text = markup
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  // Entities left in the prose are decoded only now, with no tag stripping
  // running after them.
  const decoded = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return decoded.length > 0 ? decoded : undefined;
}

export function parseDate(value: unknown): Date | undefined {
  if (value == null) return undefined;
  // Several ATSs emit epoch milliseconds as a bare number or numeric string.
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// A bare "Remote" in a location field ("USA (Remote)", "Remote - EU") is by far
// the most common way this is expressed, so matching only the emphatic variants
// silently drops most remote roles. Negations are checked first because
// "no remote work" must not read as remote.
const NEGATED_REMOTE = /\b(no|not|non|isn'?t)[- ]?remote\b|\bremote\s+(work\s+)?(is\s+)?not\b/i;
const REMOTE_WORDS = /\b(remote|telecommut\w*|work from home|wfh)\b|100%\s*remote/i;
const HYBRID_WORDS = /\bhybrid\b/i;
const ONSITE_WORDS = /\b(on[- ]?site|in[- ]?office|in[- ]?person)\b/i;

/**
 * Remote type is the single highest-leverage field for saturation scoring —
 * fully-remote listings draw an order of magnitude more applicants than on-site
 * ones — so it is worth inferring from free text when a vendor omits it.
 */
export function inferRemoteType(
  explicit: string | boolean | undefined,
  ...haystack: (string | undefined)[]
): RemoteType | undefined {
  if (typeof explicit === 'boolean') return explicit ? 'fully_remote' : undefined;
  if (typeof explicit === 'string') {
    const v = explicit.toLowerCase().replace(/[\s-]/g, '');
    if (v === 'remote' || v === 'fullyremote') return 'fully_remote';
    if (v === 'hybrid') return 'hybrid';
    if (v === 'onsite' || v === 'inoffice') return 'on_site';
  }
  const text = haystack.filter(Boolean).join(' ');
  if (!text) return undefined;
  // Hybrid outranks remote: "Remote/Hybrid - Berlin" is a hybrid role, and
  // treating it as fully remote would wrongly mark it as heavily contested.
  // Unless the text states the role IS fully remote — "fully remote; occasional
  // hybrid meetups" is remote with a caveat, not a hybrid job.
  if (HYBRID_WORDS.test(text) && !/\b(fully|100%|completely|entirely)[\s-]*remote\b/i.test(text)) {
    return 'hybrid';
  }
  if (NEGATED_REMOTE.test(text)) return 'on_site';
  if (REMOTE_WORDS.test(text)) return 'fully_remote';
  if (ONSITE_WORDS.test(text)) return 'on_site';
  return undefined;
}

/** Location strings that name no single physical place. */
const VAGUE_LOCATION =
  /^\s*(\d+\s+locations?|multiple.*|various.*|anywhere|nationwide|field.*|global|worldwide|emea|apac|latam|americas|europe|n\/a|tbd)\s*$/i;

/**
 * A location that is only a country is not a place you commute to.
 *
 * Only "united states"/"usa"/"us" were treated as vague, so 100 corpus jobs
 * located simply "India", "Canada" or "Poland" were filed as on-site — while
 * the identical string appeared as fully_remote on 40 other rows.
 */
const BARE_COUNTRY =
  /^\s*(united states( of america)?|usa|u\.s\.a?\.?|us|united kingdom|uk|great britain|canada|india|australia|new zealand|ireland|germany|france|spain|italy|portugal|netherlands|belgium|poland|romania|czechia|czech republic|hungary|austria|switzerland|sweden|denmark|norway|finland|japan|china|singapore|hong kong|taiwan|south korea|vietnam|thailand|indonesia|malaysia|philippines|israel|uae|united arab emirates|saudi arabia|egypt|south africa|kenya|nigeria|mexico|brazil|argentina|colombia|chile|costa rica)\s*$/i;

/**
 * True when a location names an actual place a person would commute to.
 *
 * Needed because several providers — Workday most of all — publish a concrete
 * office ("McLean, VA") without ever setting a remote flag. Left alone those
 * roles fall into "unknown", which hides the entire on-site pocket: the exact
 * segment this product exists to surface.
 */
export function looksPhysicalLocation(raw: string | undefined): boolean {
  if (!raw) return false;
  const t = raw.trim();
  if (t.length < 3 || VAGUE_LOCATION.test(t) || BARE_COUNTRY.test(t)) return false;
  if (/\b(remote|hybrid|virtual|work from home|wfh)\b/i.test(t)) return false;
  return /[a-z]{3}/i.test(t);
}

/**
 * inferRemoteType plus an on-site fallback for concrete locations.
 *
 * Kept separate from inferRemoteType so the fallback only fires where the caller
 * knows which string is genuinely the location field — applying it to free text
 * would misread any description that happens to mention a city.
 */
export function resolveRemoteType(
  explicit: string | boolean | undefined,
  locationRaw: string | undefined,
  ...text: (string | undefined)[]
): RemoteType | undefined {
  const inferred = inferRemoteType(explicit, locationRaw, ...text);
  if (inferred) return inferred;
  return looksPhysicalLocation(locationRaw) ? 'on_site' : undefined;
}

const SENIORITY_RULES: [RegExp, string][] = [
  [/\b(chief|cto|ceo|cfo|coo|vp|vice president)\b/i, 'executive'],
  [/\bdirector\b/i, 'director'],
  [/\b(principal|distinguished|fellow)\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  // `senior` first: with `manager` above it, "Senior Manager, Site Reliability
  // Engineering" scored as a tech lead rather than a senior people-manager.
  [/\b(senior|sr\.?|snr)\b/i, 'senior'],
  // "(Non-Manager)" contains "manager" — Workday's exact phrasing.
  [/\bnon[\s-]?manager\b/i, 'mid'],
  [/\b(manager|head of|lead)\b/i, 'lead'],
  [/\b(junior|jr\.?|entry|graduate|associate|intern(ship)?|trainee)\b/i, 'entry'],
];

/**
 * Vendor seniority fields use their own vocabulary — LinkedIn-style
 * "Mid-Senior level", Workday's "Experienced (Non-Manager)", "Not Applicable".
 * Passing those through raw left 316 corpus jobs (8.8%) with a level no filter
 * option could select and no saturation rule recognised, so every one of them
 * silently fell to the default score.
 */
const EXPLICIT_SENIORITY: [RegExp, string][] = [
  [/^not applicable$|^n\/?a$/i, ''],
  [/\b(intern(ship)?|student|trainee)\b/i, 'entry'],
  [/\b(entry|junior|graduate|new grad)\b/i, 'entry'],
  [/\bassociate\b/i, 'entry'],
  [/\bmid[- ]senior\b/i, 'senior'],
  [/\b(mid|intermediate|experienced)\b/i, 'mid'],
  [/\b(executive|chief|vp|vice president)\b/i, 'executive'],
  [/\bdirector\b/i, 'director'],
  [/\b(principal|distinguished|fellow)\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(manager|head of|lead)\b/i, 'lead'],
  [/\bsenior\b/i, 'senior'],
];

function canonicalSeniority(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  for (const [pattern, label] of EXPLICIT_SENIORITY) {
    if (pattern.test(t)) return label || undefined;
  }
  return undefined;
}

export function inferSeniority(title: string, explicit?: string): string | undefined {
  if (explicit && explicit.trim()) {
    const canon = canonicalSeniority(explicit);
    if (canon) return canon;
    // Unrecognised vendor string: fall through to the title rather than storing
    // a value nothing downstream understands.
  }
  for (const [pattern, label] of SENIORITY_RULES) {
    if (pattern.test(title)) return label;
  }
  return undefined;
}

/** Collapses a location string so the same office spelled two ways hashes alike. */
export function normalizeLocation(raw: string | undefined): string {
  if (!raw) return '';
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\((remote|hybrid|on[- ]?site|m\/f\/d|f\/m\/d|w\/m\/d)\)/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Infers seniority from description text when the title does not say.
 *
 * Titles carry the level only about two-thirds of the time — "Software Engineer"
 * says nothing — but descriptions almost always state a years-of-experience
 * requirement. Reading that closes most of the gap at the source, which is far
 * better than hiding those jobs behind a filter.
 *
 * The FIRST stated figure wins, not the smallest. Descriptions lead with the
 * headline requirement and then qualify it per skill — "minimum of 5 years in
 * software engineering and 3 years of Kubernetes" is a senior role, and taking
 * the smallest number would file it as mid.
 */
export function inferSeniorityFromText(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const text = description.slice(0, 4000);

  if (/\b(new grad|recent graduate|entry[- ]level|no experience required|0-2 years)\b/i.test(text)) {
    return 'entry';
  }

  // "5+ years", "5-8 years", "minimum of 5 years", "at least 5 years"
  // The qualifier used to be optional, so ANY number before "years" won and
  // "Founded over 25 years ago" made every role at that company principal-level.
  // Require either an experience qualifier before the figure or an experience
  // word just after it.
  const matches = [
    ...text.matchAll(
      /\b(?:minimum(?: of)?|at least|min\.?|(?:requires?|require[ds])(?: a minimum of)?)\s*(\d{1,2})\s*(?:\+|-\s*\d{1,2})?\s*(?:\+)?\s*years?\b/gi,
    ),
    ...text.matchAll(
      /\b(\d{1,2})\s*(?:\+|-\s*\d{1,2})?\s*(?:\+)?\s*years?(?:\s+(?:of|in|as|with))?\s+(?:relevant\s+|professional\s+|hands[- ]on\s+|industry\s+)?(?:experience|expertise|background)\b/gi,
    ),
  ];
  const years = matches
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 25);
  if (years.length === 0) return undefined;

  const first = years[0]!;
  if (first >= 10) return 'principal';
  if (first >= 8) return 'staff';
  if (first >= 5) return 'senior';
  if (first >= 2) return 'mid';
  return 'entry';
}
