/**
 * Checking what the model proposed, before a person ever sees it.
 *
 * WHY THE MODEL RETURNS EDITS AND NOT A RESUME
 *
 * The obvious design is "here is my CV and the job ad, write me a better CV".
 * Every product in this space does that, and it is why their output reads as
 * machine-written and occasionally lies. A whole rewritten document cannot be
 * checked against anything: there is no way to tell which sentence is the
 * person's own experience and which the model supplied to fill a gap.
 *
 * So the model returns a LIST OF REPLACEMENTS, each anchored to a line that
 * already exists in the resume. That makes three things possible that a rewrite
 * does not:
 *
 *   1. The diff is exact, because the original is named rather than inferred.
 *   2. "Never invent" becomes a check rather than a request. Every number and
 *      every technical term in a replacement has to be traceable to the source.
 *   3. Nothing is applied silently — each edit is accepted or skipped one at a
 *      time, which is also the habit that keeps a tailored CV sounding like its
 *      owner.
 *
 * THE SPECIFIC LIE THIS PREVENTS
 *
 * The failure mode is not a model writing badly. It is a model writing
 * PLAUSIBLY. Asked to match a posting that wants "reduced infrastructure spend",
 * a model will happily turn
 *
 *   "Managed cloud infrastructure for the platform team"
 *
 * into
 *
 *   "Cut cloud infrastructure spend 40% for the platform team"
 *
 * which is a specific, checkable, interview-ending claim about a number the
 * person never gave it. It reads well. It is indistinguishable from a real
 * achievement. And no amount of instructing the model not to do it makes the
 * guarantee hold, because the instruction is a request and the output is prose.
 *
 * A program comparing "40" against the resume text catches it every time.
 *
 * THREE OUTCOMES, NOT TWO
 *
 * An early version of this accepted or rejected. That was wrong in both
 * directions: it threw away useful suggestions whose wording merely could not be
 * proven, and it offered no way to tell a structural fault from an unproven
 * claim. So:
 *
 *   accepted   every claim in it traces back to the resume
 *   flagged    it introduces something unverifiable — shown WITH the specific
 *              words named, never applied on its own
 *   rejected   structurally unusable: the line it claims to edit does not exist,
 *              or it changes nothing, or it is padding
 *
 * `flagged` is the honest answer to a genuine ambiguity. If a posting asks for
 * Terraform and the resume says Terraform but never says at what scale, a
 * suggestion mentioning scale is not a lie and not provable either. The person
 * who lived it can settle that in two seconds. A program cannot, and should not
 * pretend to.
 */

/** One proposed change, as the model must return it. */
export interface Edit {
  /** The line being replaced. Must exist in the resume, verbatim. */
  original: string;
  /** What it becomes. */
  replacement: string;
  /** Why, for the person reading the diff. */
  reason: string;
  /** Which part of the CV it belongs to, when the model says. */
  section?: string;
}

export type Verdict = 'accepted' | 'flagged' | 'rejected';

export interface CheckedEdit {
  edit: Edit;
  verdict: Verdict;
  /** Plain words, shown in the UI. Never a code. */
  note: string;
  /**
   * The exact tokens that could not be traced to the resume.
   *
   * Named individually on purpose: "this mentions 40% and your CV does not" is
   * something a person can act on, and "unverified claim" is not.
   */
  unverified: string[];
}

/**
 * How much longer a replacement may be than what it replaces.
 *
 * Padding is the other AI tell, and it is the one people notice. A bullet that
 * grows by half is a rewrite; one that doubles is filler. 1.6 was chosen against
 * real examples — "Managed cloud infrastructure for the platform team" to "Ran
 * multi-region AWS and Kubernetes infrastructure for the platform team" is 1.45,
 * a legitimate edit that has to pass.
 */
export const MAX_GROWTH = 1.6;

/**
 * Short lines get absolute slack instead of the ratio.
 *
 * 1.6x of a 12-character bullet is 19 characters, which would reject almost any
 * real improvement to a short line. Below this length the ratio is not a useful
 * measure of padding.
 */
export const SHORT_LINE_SLACK = 40;

/** Anything longer than this is not a resume line. */
export const MAX_LINE_CHARS = 600;

/**
 * Equivalences that are true by definition rather than by the resume saying both.
 *
 * Deliberately tiny, and deliberately only things that are the SAME FACT written
 * two ways. "K8s" and "Kubernetes" are one skill; "containers" and "Kubernetes"
 * are not, and a list that blurred that would quietly reintroduce the fabrication
 * this file exists to stop.
 *
 * Every entry here is a claim that two strings mean the identical thing, so the
 * bar for adding one is that swapping them could never make a CV say something
 * new about its owner.
 */
const SAME_THING: readonly (readonly string[])[] = [
  ['k8s', 'kubernetes'],
  ['ci/cd', 'cicd', 'ci cd'],
  ['js', 'javascript'],
  ['ts', 'typescript'],
  ['postgres', 'postgresql'],
  ['k6s', 'k6'],
  ['gcp', 'google cloud', 'google cloud platform'],
  ['aws', 'amazon web services'],
  ['ml', 'machine learning'],
  ['iac', 'infrastructure as code'],
  ['etl', 'extract transform load'],
  ['db', 'database'],
  ['k', 'thousand'],
];

/** Whitespace flattened and case dropped, for comparison only. */
export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Words that carry a digit but assert nothing about the person.
 *
 * "24/7" and "360" appear in job adverts as turns of phrase. They are not
 * achievements and demanding the resume contain them would flag honest edits.
 */
const HARMLESS_NUMERICS = new Set(['24/7', '247', '360', '101', '1:1', '11']);

/**
 * Ordinary English that happens to be capitalised.
 *
 * NEEDED BECAUSE MOST TOOL NAMES ARE ONE CAPITALISED WORD
 *
 * The first version of claimTokens looked for digits, runs of capitals and
 * internal capitals — and so caught AWS, CI/CD and PostgreSQL while missing
 * Kafka, Airflow, Terraform, Docker and Node.js, which are the names a model is
 * most likely to add. Measured against the test set: three of the four
 * fabrications walked straight through.
 *
 * So a leading capital now counts, which drags in every word that starts a
 * sentence or a resume bullet. This is that list.
 *
 * WHICH DIRECTION THE ERRORS GO
 *
 * A word wrongly ON this list is a missed fabrication. A word wrongly OFF it is
 * a needless flag. Those costs are not symmetric, so the list is kept to closed-
 * class English and the verbs resume bullets actually begin with, and ordinary
 * nouns are deliberately left off — "Platform" being flagged occasionally is a
 * far better failure than "Kafka" being accepted once.
 *
 * Nothing that is also the name of a technology appears here, which is why Go,
 * Rust, Swift and React are absent despite being ordinary words.
 */
const COMMON_CAPITALISED = new Set<string>([
  // Closed class
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'as', 'at', 'by', 'for', 'from',
  'in', 'into', 'of', 'on', 'onto', 'to', 'with', 'within', 'without', 'across', 'after',
  'before', 'during', 'over', 'under', 'per', 'via', 'while', 'when', 'where', 'this', 'that',
  'these', 'those', 'it', 'its', 'we', 'our', 'us', 'i', 'my', 'me', 'they', 'their', 'them',
  'he', 'his', 'she', 'her', 'you', 'your', 'all', 'both', 'each', 'every', 'no', 'not', 'also',
  'is', 'was', 'are', 'were', 'be', 'been', 'being', 'has', 'had', 'have', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'may', 'might', 'shall', 'should', 'must',
  // The verbs resume bullets begin with
  'achieved', 'administered', 'analysed', 'analyzed', 'architected', 'audited', 'authored',
  'automated', 'built', 'collaborated', 'configured', 'coordinated', 'created', 'cut',
  'defined', 'delivered', 'deployed', 'designed', 'developed', 'documented', 'drove',
  'enabled', 'engineered', 'ensured', 'established', 'evaluated', 'executed', 'exceeded',
  'facilitated', 'fixed', 'founded', 'generated', 'grew', 'handled', 'headed', 'hired',
  'identified', 'implemented', 'improved', 'increased', 'initiated', 'installed', 'integrated',
  'introduced', 'launched', 'led', 'maintained', 'managed', 'measured', 'mentored', 'migrated',
  'monitored', 'negotiated', 'optimised', 'optimized', 'organised', 'organized', 'oversaw',
  'owned', 'partnered', 'planned', 'presented', 'prioritised', 'prioritized', 'produced',
  'promoted', 'provided', 'ran', 'recommended', 'reduced', 'refactored', 'reported',
  'researched', 'resolved', 'restructured', 'reviewed', 'saved', 'scaled', 'shipped',
  'simplified', 'sourced', 'spearheaded', 'standardised', 'standardized', 'streamlined',
  'supervised', 'supported', 'tested', 'trained', 'transformed', 'upgraded', 'validated',
  'worked', 'wrote',
  // Headings and the furniture around dates
  'experience', 'education', 'skills', 'summary', 'profile', 'projects', 'achievements',
  'certifications', 'references', 'interests', 'present', 'current', 'contact',
]);

/**
 * The parts of a sentence that make a claim.
 *
 * Two kinds, and they are the two ways a CV can be made to say something untrue:
 *
 *   NUMBERS — "40%", "15,000", "3x", "2019". The dangerous half. A number is
 *   specific, checkable by an interviewer, and the thing a model reaches for when
 *   asked to sound accomplished.
 *
 *   TECHNICAL NAMES — "Kubernetes", "Terraform", "PostgreSQL", "CI/CD". Claiming
 *   a tool the person never used is the other half, and it is the one a posting
 *   invites: the job asks for Terraform, so the model helpfully adds Terraform.
 *
 * Ordinary English is deliberately NOT extracted. "Ran", "multi-region",
 * "platform" assert nothing on their own, and requiring every word to appear in
 * the source would reject all rephrasing, which is the entire point of the
 * feature.
 */
export function claimTokens(text: string): string[] {
  const out: string[] = [];
  // Split on whitespace only. Punctuation is trimmed per token below, because
  // splitting on it would tear "CI/CD" and "Node.js" into meaningless halves.
  for (const raw of text.split(/\s+/)) {
    // Strip punctuation that is grammar rather than part of the name. Inner
    // characters are left alone: the dot in "Node.js" and the slash in "CI/CD"
    // belong to the token, while a trailing comma does not.
    const token = raw.replace(/^[^\w$+#]+/, '').replace(/[^\w$+#%]+$/, '');
    if (!token) continue;

    const hasDigit = /\d/.test(token);
    // Two or more capitals in a row, allowing the punctuation that acronyms
    // carry: AWS, CI/CD, SQL, GDPR.
    const isAcronym = /^[A-Z][A-Z0-9/.+#-]{1,}$/.test(token);
    // A capital somewhere after the first character is how product names are
    // spelled and ordinary words are not: PostgreSQL, TypeScript, pgvector is
    // caught by the lowercase-with-digit rule instead.
    const isProductName = /[a-z][A-Z]/.test(token);
    // A leading capital, which is how Kafka, Airflow, Terraform and Docker are
    // written — the names a model is most likely to add. Filtered against
    // COMMON_CAPITALISED so sentence openers do not all become claims.
    const isNamed =
      /^[A-Z]/.test(token) && !COMMON_CAPITALISED.has(token.toLowerCase().replace(/[.,;:]+$/, ''));

    if (hasDigit && HARMLESS_NUMERICS.has(token.toLowerCase())) continue;
    if (hasDigit || isAcronym || isProductName || isNamed) out.push(token.toLowerCase());
  }
  return out;
}

/**
 * Whether a token appears in the source as a token, not as a fragment.
 *
 * Bounded on purpose. Plain `includes` would find "40" inside "2040" and inside
 * "$1,409", so a fabricated "40% improvement" would verify against a resume that
 * merely mentioned the year 2040 — which is exactly the check failing silently in
 * the direction that matters.
 */
export function containsClaim(source: string, token: string): boolean {
  const hay = normalise(source);
  const needle = normalise(token);
  if (!needle) return false;

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Not \b: the token may legitimately end in a symbol (`40%`, `c++`), and \b
  // between a symbol and a space never matches. Framed as "not flanked by a
  // word character" instead, which is the property actually wanted.
  if (new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`).test(hay)) return true;

  // A number written with thousands separators in one place and not the other is
  // the same number, and it has to work BOTH ways round: "15,000" in the edit
  // against "15000" in the CV, and "15000" in the edit against "15,000" in the
  // CV. The first version only stripped the needle, so the second case reported
  // a fabricated number for a figure the resume plainly stated.
  if (/\d/.test(needle)) {
    const bareNeedle = needle.replace(/,/g, '');
    // Separators removed from digit groups only, so prose commas are untouched.
    const bareHay = hay.replace(/(\d),(?=\d)/g, '$1');
    if (bareNeedle !== needle || bareHay !== hay) {
      const esc = bareNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\w])${esc}($|[^\\w])`).test(bareHay)) return true;
    }
  }

  for (const group of SAME_THING) {
    if (!group.includes(needle)) continue;
    for (const alias of group) {
      if (alias === needle) continue;
      const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\w])${esc}($|[^\\w])`).test(hay)) return true;
    }
  }
  return false;
}

/** The length a replacement may reach before it is padding. */
export function growthCeiling(original: string): number {
  return Math.max(original.length * MAX_GROWTH, original.length + SHORT_LINE_SLACK);
}

/**
 * One edit, checked against the resume it claims to be editing.
 *
 * The resume is the ONLY source of truth for claims. The job description is
 * deliberately not consulted: its words are there to be matched, not to be
 * borrowed as facts, and allowing a term because the POSTING mentions it is
 * precisely how "they want Terraform" becomes "I have used Terraform".
 */
export function verifyEdit(edit: Edit, resumeText: string): CheckedEdit {
  const original = (edit.original ?? '').trim();
  const replacement = (edit.replacement ?? '').trim();
  const reject = (note: string): CheckedEdit => ({ edit, verdict: 'rejected', note, unverified: [] });

  if (!original) return reject('the model did not say which line it was changing');
  if (!replacement) return reject('the model proposed an empty replacement');
  if (replacement.length > MAX_LINE_CHARS) {
    return reject(`the replacement is ${replacement.length} characters, which is not a resume line`);
  }

  // THE ANCHOR CHECK.
  //
  // A model that invents the line it is editing has invented the whole edit, and
  // applying it would add a sentence rather than change one. This is also the
  // check that catches a stale resume: edits computed against an older version
  // simply stop matching instead of being applied to the wrong text.
  if (!normalise(resumeText).includes(normalise(original))) {
    return reject('that line is not in your resume, so there is nothing to replace');
  }

  if (normalise(original) === normalise(replacement)) {
    return reject('the replacement is the same as the original');
  }

  if (replacement.length > growthCeiling(original)) {
    return reject(
      `the replacement is ${replacement.length} characters against ${original.length} — that is padding, not tailoring`,
    );
  }

  // THE CLAIM CHECK, which is the reason this file exists.
  //
  // Every claim in the replacement is looked for in the resume, and that one
  // rule covers both cases. A token the edit CARRIES OVER from the line it
  // replaces needs no special handling: the anchor check above has already
  // established that the original appears in the resume verbatim, so anything
  // inside it is in the resume by construction.
  //
  // An earlier version kept a separate set of carried tokens and excluded them
  // first. A mutation that deleted that set broke no test — which was the
  // correct answer rather than a gap in the tests. Given the anchor check the
  // set was unreachable, and unreachable code shaped like a safeguard is worse
  // than no code at all, because the next reader trusts it.
  const unverified = claimTokens(replacement).filter((t) => !containsClaim(resumeText, t));

  if (unverified.length > 0) {
    return {
      edit,
      verdict: 'flagged',
      note:
        `this adds ${unverified.map((u) => `"${u}"`).join(', ')}, which ` +
        `${unverified.length === 1 ? 'is' : 'are'} not in your resume — only accept it if it is true`,
      unverified,
    };
  }

  return { edit, verdict: 'accepted', note: 'every detail in this traces back to your resume', unverified: [] };
}

export interface CheckSummary {
  checked: CheckedEdit[];
  accepted: number;
  flagged: number;
  rejected: number;
  /** One line for the log, and for measuring whether the checks are too strict. */
  note: string;
}

/**
 * A whole set of edits, checked and counted.
 *
 * The counts are not decoration. Whether these rules are too strict is an
 * empirical question — a run that rejects most of what the model proposed is
 * either a bad model or a bad rule, and there is no way to tell which without
 * the numbers.
 */
export function verifyEdits(edits: readonly Edit[], resumeText: string): CheckSummary {
  const checked = edits.map((e) => verifyEdit(e, resumeText));
  const count = (v: Verdict) => checked.filter((c) => c.verdict === v).length;
  const accepted = count('accepted');
  const flagged = count('flagged');
  const rejected = count('rejected');
  return {
    checked,
    accepted,
    flagged,
    rejected,
    note: `tailor: ${edits.length} proposed — ${accepted} verified, ${flagged} need your judgement, ${rejected} discarded`,
  };
}
