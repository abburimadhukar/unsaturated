import type { NormalizedJob } from '../ats/types.js';

/**
 * Institutional employers: universities, hospitals, charities, public bodies.
 *
 * These employers are structurally short of technical staff. 66% of health-IT
 * professionals report persistent shortages, and university technology leaders
 * lose candidates to tech firms on pay and flexibility — not a cycle, a standing
 * condition. Fewer applicants per posting, for reasons that will not change.
 *
 * WHY THE OBVIOUS ROUTES DO NOT WORK
 *
 * Measured against the live corpus, every identifier we already hold fails:
 *
 *   employer name ("University of…")      18 of 33,061 jobs   0.1%
 *   employer website domain (.edu, .org)  569 of 23,958 boards, ZERO .edu
 *   pattern-matching the ATS token        4.6% of boards, and the wrong ones
 *
 * The company column is not a company name. It is the ATS slug: Harvard is
 * "harvard", but Michigan is "umich" and Ace Hardware is "ACE1002CORP". UKG —
 * the system US hospitals and school districts actually run on — returns no
 * employer name at all, verified against its live API.
 *
 * Worse, token matching is confidently wrong. Searching for "health" and
 * "foundation" in slugs returned alpacahealth, bayesianhealth,
 * ambiencehealthcare and aptosfoundation: venture-funded digital-health
 * startups and a crypto foundation. The exact opposite of the ask.
 *
 * WHAT DOES WORK
 *
 * The job's own text. Institutions write like institutions — students, faculty,
 * patients, our mission, 501(c)(3) — and startups do not. Tested against five
 * live Cornell postings through the Workday detail API: five out of five
 * correctly identified, including "eCornell Senior Salesforce Developer".
 *
 * So this reads the description first and treats the name only as corroboration,
 * never as proof. A slug saying "health" earns nothing on its own.
 */

export type Sector = 'education' | 'health' | 'nonprofit' | 'government' | 'research';

export const SECTOR_LABELS: Record<Sector, string> = {
  education: 'Universities & schools',
  health: 'Hospitals & health systems',
  nonprofit: 'Charities & non-profits',
  government: 'Government & public bodies',
  research: 'Research institutes & museums',
};

export const SECTOR_ORDER: Sector[] = [
  'education',
  'health',
  'nonprofit',
  'government',
  'research',
];

/**
 * Language only an institution uses about itself.
 *
 * Every one of these describes the ORGANISATION, not the product. That is the
 * distinction that separates a hospital from a hospital-software startup: both
 * say "patients", but only one says "our patients" and "bedside" and "across
 * our health system".
 */
const STRONG: Record<Sector, RegExp> = {
  education: new RegExp(
    [
      String.raw`\b(our|the)\s+(university|college|campus|institution)\b`,
      String.raw`\b(faculty|provost|dean of|tenure[- ]track|registrar|academic affairs)\b`,
      String.raw`\b(our|the|its)\s+students\b`,
      String.raw`\b(school district|higher education|land[- ]grant|undergraduate|postgraduate)\b`,
      String.raw`\b(equal opportunity employer and educator|title ix|ferpa)\b`,
    ].join('|'),
    'i',
  ),
  health: new RegExp(
    [
      String.raw`\b(our|the)\s+(hospital|health system|medical cent(er|re)|clinic)\b`,
      String.raw`\b(our|its)\s+patients\b`,
      String.raw`\b(academic medical cent(er|re)|bedside|inpatient|outpatient|ambulatory)\b`,
      String.raw`\b(clinical staff|care team|nursing staff|attending physician|patient care)\b`,
      String.raw`\b(nhs\s+(trust|foundation|england|scotland)|magnet[- ]designated)\b`,
    ].join('|'),
    'i',
  ),
  nonprofit: new RegExp(
    [
      String.raw`\b501\s*\(\s*c\s*\)\s*\(?\s*3`,
      String.raw`\b(non[- ]?profit|not[- ]for[- ]profit)\s+(organi[sz]ation|organisation|employer|status)\b`,
      String.raw`\b(our donors|donor[- ]funded|philanthropic|fundrais(ing|er)|grant[- ]funded)\b`,
      String.raw`\b(registered charity|charity number|charitable (trust|foundation|organi[sz]ation))\b`,
      String.raw`\b(our mission[- ]driven|mission[- ]driven non)\b`,
    ].join('|'),
    'i',
  ),
  government: new RegExp(
    [
      String.raw`\b(city|county|state|federal|municipal|borough|parish)\s+of\s+[a-z]`,
      String.raw`\b(public sector|civil service|government agency|local authority)\b`,
      String.raw`\b(merit system|classified service|gs[- ]?\d{1,2}\s+(level|scale|grade))\b`,
      String.raw`\b(department of (transportation|health|education|human services))\b`,
    ].join('|'),
    'i',
  ),
  research: new RegExp(
    [
      String.raw`\b(our|the)\s+(research institute|laboratory|observatory|museum)\b`,
      String.raw`\b(principal investigator|peer[- ]reviewed|research grant|national laborator)`,
      String.raw`\b(scientific staff|research programme|postdoctoral)\b`,
    ].join('|'),
    'i',
  ),
};

/**
 * The employer's own name, as far as we know it.
 *
 * A TIE-BREAKER, and nothing more. It decides which sector wins when a posting
 * reads as two — a university hospital is genuinely both — and it can never
 * establish a sector on its own.
 *
 * An earlier version let weak language decide when the name agreed: "patients"
 * plus a slug containing "health". Measured against live boards, that scored
 * 14/17 and every one of the three failures was a false positive — a Staff ML
 * Engineer at bayesianhealth and a Strategic Growth Executive at
 * ambiencehealthcare filed as hospital jobs, and a crypto foundation filed as a
 * charity. That is the token-matching mistake this file exists to avoid,
 * wearing one extra condition. Removed rather than tuned: on a page whose
 * entire value is "these employers struggle to hire", a venture-funded startup
 * is not a near miss, it is the opposite of the answer.
 */
const NAME_HINT: Record<Sector, RegExp> = {
  education: /(universit|college|school|academy|campus|polytech|\bisd\b|\bunisa\b|\.edu\b)/i,
  health: /(hospital|health\s?system|medical|clinic|\bnhs\b|healthcare|infirmary|hospice)/i,
  nonprofit: /(foundation|charity|charitable|ministries|diocese|\bymca\b|goodwill|habitat|society|council|trust)/i,
  government: /(county|municipal|\bcity of\b|\bstate of\b|\bgov\b|borough|district|library|authority)/i,
  research: /(research|institute|laborator|museum|observatory)/i,
};

/**
 * Language that means "we sell TO institutions", not "we are one".
 *
 * This is the whole reason naming rules failed. A health-tech startup's advert
 * is full of hospital vocabulary and must not be filed beside an actual
 * hospital, because the entire value of the page is that these employers are
 * hard to hire for — a Series B startup is not.
 */
const VENDOR = new RegExp(
  [
    String.raw`\b(series [a-e]\b|seed[- ]stage|venture[- ]backed|our investors|yc\s?[swf]\d{2})\b`,
    String.raw`\b(our (platform|product|saas|software|customers|clients|users))\b`,
    String.raw`\b(b2b|go[- ]to[- ]market|arr\b|mrr\b|product[- ]market fit)\b`,
    String.raw`\b(we (are building|build|sell)|our customers include)\b`,
    String.raw`\b(health\s?(tech|care) (startup|company)|ed\s?tech)\b`,
    // A hospital does not call itself a startup. Bayesian Health's advert opens
    // "startup on a mission to make healthcare proactive" and still tripped the
    // clinical-language test on "care team members".
    String.raw`\bstart[- ]?up\b`,
    // The tell that separates selling to institutions from being one. Ambience
    // says "our health system partners" and "inpatient settings at the top
    // health systems" — its customers' wards, not its own.
    String.raw`\b(our|the)\s+(\w+\s+){0,2}(partners?|customers?|clients?)\b`,
    String.raw`\b(hospital|health system|clinic|universit\w+|school|district)\s+(partners?|customers?|clients?)\b`,
    String.raw`\b(deployed|rolled out|live)\s+(at|across|in)\s+(top\s+)?(hospitals|health systems|universities|schools)\b`,
  ].join('|'),
  'i',
);

export interface SectorInput {
  title: string;
  descriptionText?: string | null;
  company?: string | null;
  token?: string | null;
}

export interface SectorResult {
  sector: Sector | null;
  /** Why, in words — so a wrong answer can be argued with rather than guessed at. */
  reason: string | null;
}

/**
 * Decides whether a posting belongs to an institution.
 *
 * Order matters. The vendor test runs FIRST and is absolute: a company that
 * talks about its platform, its customers or its funding round is not a
 * hospital, however much clinical vocabulary its advert carries.
 */
export function classifySector(job: SectorInput): SectorResult {
  const text = job.descriptionText ?? '';
  const name = `${job.company ?? ''} ${job.token ?? ''}`;

  // Nothing to read means nothing to conclude. Workday and UKG listings often
  // carry no description, and a name on its own is not evidence — claiming it
  // anyway is how a crypto foundation ends up filed under charities.
  if (!text) return { sector: null, reason: null };

  if (VENDOR.test(text)) return { sector: null, reason: null };

  const matched = SECTOR_ORDER.filter((s) => STRONG[s].test(text));
  if (matched.length === 0) return { sector: null, reason: null };

  // A university hospital reads as both, and it is both. The employer's own
  // name is the only thing that can say which half is doing the hiring, so it
  // breaks the tie and never more than that.
  const byName = matched.find((s) => NAME_HINT[s].test(name));
  const sector = matched.length > 1 && byName ? byName : matched[0]!;

  return {
    sector,
    reason:
      matched.length > 1
        ? 'The advert reads as more than one, and the employer name decides'
        : 'The advert describes the organisation as one',
  };
}

/** Convenience wrapper for the crawl, which holds a NormalizedJob and a board. */
export function sectorOf(job: NormalizedJob, company: string, token: string): Sector | null {
  return classifySector({
    title: job.title,
    descriptionText: job.descriptionText ?? null,
    company,
    token,
  }).sector;
}
