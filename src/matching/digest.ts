/**
 * The text a job is embedded as.
 *
 * WHY THIS IS NOT JUST THE DESCRIPTION
 *
 * The model is @cf/baai/bge-small-en-v1.5, and its input limit is 512 TOKENS.
 * Verified against Cloudflare's model page on 11 Sep 2026: 384 output
 * dimensions, 512 maximum input tokens. A median job description sampled from
 * 101 real postings that day was 8,260 characters — roughly 2,065 tokens, four
 * times the limit. Hand the model a description and three quarters of it is
 * silently dropped.
 *
 * So something has to choose what survives, and the choice is the feature. Get
 * it wrong and every job looks like every other job.
 *
 * WHAT GOES IN, IN ORDER OF VALUE
 *
 * Ordered deliberately, because truncation takes from the END. Whatever gets
 * cut should be the least useful thing present, not whatever happened to be
 * last:
 *
 *   1. title            the single strongest signal, ~10 tokens
 *   2. seniority        "senior" vs "intern" matters more than any skill
 *   3. specialization   our own classification, already computed
 *   4. skills the ad named
 *   5. the REQUIREMENTS part of the body, not its opening
 *
 * WHAT IS LEFT OUT, AND WHY
 *
 * The company name. It is not a skill, and it drags every posting from one
 * employer together regardless of role — 2,107 Cleveland Clinic jobs would
 * cluster on "Cleveland Clinic" rather than on what the work is.
 *
 * The location. Same failure in a different direction: include it and every
 * London job sits near every other London job, whatever the work. Location is a
 * filter the feed already applies, and a filter is exactly the right tool for
 * something with a definite answer. A vector is for the fuzzy part.
 */

/** Everything needed to compose a digest. A row, or a freshly crawled job. */
export interface DigestInput {
  title: string;
  seniority?: string | null;
  family?: string | null;
  specialization?: string | null;
  matchedSkills?: readonly string[] | null;
  /** The body, when the provider gave one. Workday's listing gives none. */
  description?: string | null;
}

/**
 * 1,500 characters, not 2,048.
 *
 * 512 tokens is about 2,048 characters at the usual four-per-token, but
 * technical prose tokenises worse than that — version numbers, CamelCase and
 * punctuation all split — so the real ratio is nearer 3.5. 1,500 leaves room to
 * be wrong about it. Exceeding the limit is not fatal either way, since the
 * model truncates rather than failing; this is about controlling WHAT is lost.
 */
export const MAX_DIGEST_CHARS = 1_500;

/**
 * Where the requirements usually start.
 *
 * The opening of a job ad is almost never about the job. It is the company: "a
 * leading provider of...", "founded in 2011...", "our mission is...". Embedding
 * that makes every ad from every company look alike, which is the opposite of
 * what this is for.
 *
 * The part worth reading begins at a heading. These are the ones that actually
 * appear, in rough order of how specific they are to requirements.
 */
const SECTION_STARTS = [
  'requirements',
  'qualifications',
  'what you.{0,3}ll need',
  'what we.{0,3}re looking for',
  'who you are',
  'your profile',
  'skills and experience',
  'minimum qualifications',
  'basic qualifications',
  'you have',
  'you will have',
  'must have',
  'what you.{0,3}ll do',
  'responsibilities',
  'the role',
  'about the role',
  'about this role',
  'job description',
];

const SECTION_RE = new RegExp(`(?:^|\\n|\\.|:)\\s*(?:${SECTION_STARTS.join('|')})\\b`, 'i');

/**
 * Noise that costs tokens and carries no meaning about the work.
 *
 * Measured across 410 real postings on 11 Sep 2026: 11% of digests contained a
 * URL. They are recruiter LinkedIn profiles and application links — 60-odd
 * characters of random path that the model has to embed as something.
 */
function stripNoise(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\bwww\.\S+/g, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ');
}

/**
 * Sentences that introduce a company or a person rather than a job.
 *
 * The opening of an ad is usually not about the work. Across the same 410
 * postings, 48% had no requirements heading at all, and the fallback handed back
 * things like:
 *
 *   "Hi 👋 I'm Colin, Director of Engineering, Europe. How do you feel about..."
 *   "Hi! 👋 I'm Chris, head of Product Design at Ashby. We're looking for a..."
 *
 * Embedding that puts every ad from one company — and every ad written by the
 * same hiring manager — in the same neighbourhood, whatever the role.
 */
const INTRO_RE = new RegExp(
  [
    '^(?:hi|hello|hey)\\b',
    "^i.{0,3}m\\s+[A-Z]",
    '^i am\\s+[A-Z]',
    '^about (?:us|the company|our)',
    '^who we are',
    "^we(?:.{0,3}re| are)\\s+(?:a|an|the|looking|hiring)",
    '^our (?:mission|team|company|story|vision)',
    '^founded in\\b',
    '^at [A-Z][\\w.&-]*,',
  ].join('|'),
  'i',
);

/** Caps how much of an opening may be discarded, so a short ad is never emptied. */
const MAX_INTRO_SENTENCES = 4;

/**
 * The useful middle of a description.
 *
 * Three steps, cheapest first. A heading is the strongest signal and wins
 * outright. Failing that, leading introduction sentences are dropped. Failing
 * that the opening is returned as-is, because some good ads are three paragraphs
 * with no structure at all and returning nothing would throw away the only text
 * there is.
 */
export function requirementsPart(description: string): string {
  const clean = stripNoise(description);

  const m = SECTION_RE.exec(clean);
  // From the heading, not after it: the heading word itself is a signal, and
  // "Requirements" before a list of tools is worth the eight characters. The
  // leading punctuation the pattern may have matched is not.
  if (m) return clean.slice(m.index).replace(/^[\s.:]+/, '');

  // Sentence-ish split. Not a real parser: the only question is whether the
  // NEXT chunk still looks like an introduction, and a chunk boundary in the
  // wrong place costs one sentence of precision, not correctness.
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let drop = 0;
  while (
    drop < sentences.length - 1 &&
    drop < MAX_INTRO_SENTENCES &&
    INTRO_RE.test(sentences[drop]!.trim())
  ) {
    drop++;
  }
  // Never return empty: if every sentence looked like an introduction, the
  // introduction is all there is and it is better than nothing.
  return drop === 0 ? clean : sentences.slice(drop).join(' ').trim() || clean;
}

/** Normalises whitespace without touching the words. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The digest, assembled.
 *
 * Deterministic: the same job always produces the same string, which is what
 * makes the hash beside it meaningful. Nothing here consults a clock, a random
 * source or the network.
 */
export function digestFor(job: DigestInput): string {
  const parts: string[] = [];

  const title = flatten(job.title ?? '');
  if (title) parts.push(title);

  // Labelled rather than bare. "senior" on its own is a word the model has to
  // guess the role of; "Seniority: senior" is not.
  if (job.seniority) parts.push(`Seniority: ${flatten(job.seniority)}`);

  // The specialization is the more specific of the two, so it leads. Family is
  // only added when there is no specialization, since "software / backend" adds
  // nothing over "backend".
  if (job.specialization) parts.push(`Specialization: ${flatten(job.specialization)}`);
  else if (job.family) parts.push(`Field: ${flatten(job.family)}`);

  const skills = (job.matchedSkills ?? []).map((s) => flatten(s)).filter(Boolean);
  if (skills.length > 0) parts.push(`Skills: ${skills.join(', ')}`);

  const body = flatten(job.description ?? '');
  if (body) parts.push(flatten(requirementsPart(body)));

  // Joined with a full stop and a space so the model sees sentence boundaries
  // rather than one run-on string.
  const joined = parts.join('. ');
  if (joined.length <= MAX_DIGEST_CHARS) return joined;

  // Cut on a word boundary. A half-word is a token the model has never seen and
  // carries no meaning at all.
  const cut = joined.slice(0, MAX_DIGEST_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_DIGEST_CHARS * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * A short, stable fingerprint of the digest.
 *
 * Stored instead of the digest itself, which is what lets the crawl skip a job
 * whose composition has not changed without keeping a copy of the prose. The
 * project's standing rule is that no job description and no CV text lives in
 * the database; a hash honours that and a cached digest would not.
 *
 * crypto.subtle rather than node:crypto so the same function works in the
 * crawler under Node and inside the Worker, which has no node:crypto.
 *
 * Truncated to 32 hex characters. This is a change-detector, not a security
 * boundary — nobody is trying to forge a collision to avoid being re-embedded.
 */
export async function digestHash(digest: string): Promise<string> {
  const bytes = new TextEncoder().encode(digest);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
