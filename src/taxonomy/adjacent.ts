import type { NormalizedJob } from '../ats/types.js';
import { debugScores, HRIS_PRODUCTS, HRIS_NON_HR_MODULE, type Family } from './families.js';

/**
 * Roles that are technically related but do not belong to a core family.
 *
 * A flag, never a fifth family. A Technical Program Manager is not a peer of
 * "Cloud" and "Data"; it is a cloud or software job wearing a title the core
 * rules refuse. Families answer "what is this work"; this answers "how close to
 * the centre is it", which is a different axis and has to filter independently.
 *
 * These are worth surfacing precisely because they are unloved: people who can
 * do the work do not search for them, so the applicant pool is thin. That is the
 * whole argument for the feature, and it is also why they must be OFF by
 * default — someone looking for a Backend Engineer should not be handed a
 * Technical Support Engineer unless they asked.
 *
 * The vocabulary below is not invented. It was read off the exclusion tally
 * after the crawl began recording what it discards, sorted by how many postings
 * each title actually costs:
 *
 *   business analyst / senior business analyst / analyst   1,481
 *   senior|staff|principal|lead engineer (unqualified)      1,390
 *   technical program|project|product manager                791
 *   systems engineer / senior systems engineer               578
 *   technical support engineer / specialist                  537
 *   test engineer / automation engineer                      394
 *   solution architect                                       276
 *   application engineer                                     236
 *
 * The blocklist matters more than the vocabulary. The same tally showed the
 * discard pile is dominated by other engineering disciplines — 543 mechanical,
 * 524 process, 480 manufacturing, 443 quality, 387 electrical, 929 project
 * engineers at ABB alone. Matching "engineer" without excluding those would bury
 * the feed in industrial roles and destroy the thing it is meant to add.
 */

export type AdjacentCategory =
  | 'hris_platform'
  | 'hris_operations'
  | 'business_analysis'
  | 'technical_pm'
  | 'systems_engineering'
  | 'technical_support'
  | 'test_automation'
  | 'solution_architecture'
  | 'generic_engineering';

export const ADJACENT_LABELS: Record<AdjacentCategory, string> = {
  hris_platform: 'HR platform, non-HR modules',
  hris_operations: 'Payroll & benefits management',
  business_analysis: 'Business / systems analysis',
  technical_pm: 'Technical program & project management',
  systems_engineering: 'Systems engineering',
  technical_support: 'Technical support',
  test_automation: 'Test & automation',
  solution_architecture: 'Solution architecture',
  generic_engineering: 'Unqualified engineering titles',
};

/**
 * Disciplines that share the word "engineer" and share nothing else.
 *
 * Checked before anything below. A Senior Mechanical Engineer and a Senior
 * Engineer differ by one word, and only one of them belongs anywhere near this
 * site.
 */
const NEVER_ADJACENT =
  /\b(mechanical|electrical|electronics|civil|chemical|process|manufactur\w*|production|quality|industrial|structural|aerospace|automotive|biomedical|environmental|geotechnical|geological|mining|petroleum|drilling|welding|hvac|plumbing|marine|nuclear|packaging|textile|food|agricultur\w*|plant|facilities|field service|construction|survey\w*|cad|autocad|solidworks|piping|instrumentation|calibration|maintenance technician)\b/i;

/**
 * Physical and hardware engineering, which "Systems Engineer" attracts.
 *
 * The first crawl with adjacent switched on returned "Senior Fuel Systems
 * Engineer, Air Vehicles" and "Senior Battery Systems Engineer" at Anduril, and
 * "Ground Systems Engineer II - Structures & Mechanisms" at Rocket Lab. None
 * tripped the list above: it had `structural` and not `structures`, `aerospace`
 * and not `air vehicles`, and nothing at all for fuel or batteries. Systems
 * engineering is a whole discipline outside software and the title alone cannot
 * separate the two.
 */
const HARDWARE_ENGINEERING =
  /\b(battery|batteries|fuel|thermal|propulsion|avionics|air vehicles?|spacecraft|satellite|launch|payload|airframe|flight|ground systems?|structures|mechanisms|mechatronics|robotics|motor|powertrain|optical|optics|laser|photonics|antenna|rf|microwave|semiconductor|silicon|wafer|asic|fpga|pcb|circuit|analog|bios|hardware|sensor|actuator|hydraulic|pneumatic|acoustic)\b/i;

/**
 * Words that make "Systems Engineer" an IT role rather than a physical one.
 *
 * Required for that one rule. A blocklist can only ever name the disciplines
 * someone thought of, so this asks for positive evidence instead: no IT word
 * anywhere in the title or description, no match.
 */
const IT_SIGNAL =
  /\b(information (technology|systems)|linux|unix|windows|server|network|cloud|aws|azure|gcp|infrastructure|enterprise|active directory|vmware|virtuali[sz]\w*|storage|datacent(er|re)|sccm|intune|citrix|sql|database|erp|sap|saas|devops|kubernetes|docker|ansible|powershell|bash|python)\b/i;

/**
 * "IT" as an acronym: case-sensitive, and against the title only.
 *
 * It cannot join the pattern above. That one is case-insensitive and tested
 * against the description, where the English word "it" appears in essentially
 * every posting — so including it would make the check pass for everything and
 * quietly do nothing, which is worse than not having it.
 */
const IT_ACRONYM = /\bIT\b/;

/**
 * Titles that carry a technical word but name a job that is not technical.
 *
 * "Security Officer" is the largest single title in the whole discard pile at
 * 1,024 postings, and every one of them is a guard rather than an infosec role.
 */
const NOT_A_TECH_ROLE =
  /\b(security (officer|guard|specialist)|behavio(u)?r analyst|data entry|data collector|loss prevention|dispatch|scheduler|claims|underwrit\w*|actuar\w*|nurse|pharmac\w*|phlebotom\w*|radiolog\w*|teller|cashier|barista|server|host(ess)?)\b/i;

interface AdjacentRule {
  category: AdjacentCategory;
  pattern: RegExp;
  /** Where the role lands when the description gives no better answer. */
  fallback: Family;
}

const RULES: AdjacentRule[] = [
  // Both HRIS rules come first, because core HRIS has already had its say: this
  // pass only ever sees titles no family claimed, so anything with a vendor
  // product or a payroll word left over is by definition the case the core
  // rules deliberately declined.
  //
  // Workday Financials, Supply Chain, Adaptive Planning: the same platform,
  // different work. Someone with Workday experience can do these, and an HR
  // filter should not return them unasked.
  {
    category: 'hris_platform',
    pattern: new RegExp(`${HRIS_PRODUCTS.source}`, 'i'),
    fallback: 'hris',
  },
  // Payroll, benefits and compensation MANAGEMENT. 80 of the 94 such titles in
  // the corpus are Manager, Director, Head, Lead, VP or Partner — they run the
  // function and its vendors rather than the system. The systems half of the
  // same vocabulary was already taken by core HRIS above.
  {
    category: 'hris_operations',
    // 'people operations' is deliberately absent. It is generic HR — People
    // Operations Generalist, People Operations Partner — not payroll or
    // benefits work, and it was pulling 130 such roles in here. Tier 4 was
    // considered and declined: an HR Business Partner under a filter called
    // HRIS makes the label a lie, whichever side of the adjacent line it sits.
    pattern: /\b(payroll|benefits|total rewards|compensation)\b/i,
    fallback: 'hris',
  },
  // "Technical" is required. Plain Product and Project Managers are the bulk of
  // the 15,038 postings the management rule drops, and they are correctly
  // dropped — only 595 of them carry "technical", and those are engineers.
  {
    category: 'technical_pm',
    pattern: /\btechnical\s+(program|project|product|delivery|engagement)\s+manager\b/i,
    fallback: 'software',
  },
  {
    // Before systems_engineering, and the order is load-bearing. That rule used
    // to carry the generic "systems analyst", which swallowed "Business Systems
    // Analyst" and filed an analyst as an infrastructure engineer. Rules are
    // tried in order, so the specific phrase has to be reached first.
    category: 'business_analysis',
    pattern:
      /\b(business\s+(systems\s+)?analyst|business\s+intelligence|systems\s+analyst|data\s+analyst|reporting\s+analyst|product\s+analyst|marketing\s+analyst|operations\s+analyst|process\s+analyst|integration\s+analyst|enterprise\s+architecture\s+analyst)\b/i,
    fallback: 'data',
  },
  {
    category: 'systems_engineering',
    // "systems analyst" is deliberately absent: business_analysis above owns
    // every analyst title. This rule is about engineers.
    pattern: /\b(systems?\s+engineer|systems?\s+specialist|infrastructure\s+specialist)\b/i,
    fallback: 'cloud',
  },
  {
    category: 'technical_support',
    pattern: /\b(technical\s+support|support\s+engineer|application\s+support|production\s+support|escalation\s+engineer|customer\s+reliability)\b/i,
    fallback: 'cloud',
  },
  {
    category: 'test_automation',
    pattern: /\b(test\s+engineer|automation\s+engineer|test\s+automation|validation\s+engineer|\bqa\b|quality\s+assurance\s+(engineer|analyst))\b/i,
    fallback: 'software',
  },
  {
    category: 'solution_architecture',
    pattern: /\b(solutions?\s+architect|enterprise\s+architect|technical\s+architect|integration\s+architect)\b/i,
    fallback: 'cloud',
  },
  // Last, and the loosest: an engineering title with no discipline attached.
  // At a software company "Staff Engineer" is a software engineer; at ABB it is
  // not, which is what NEVER_ADJACENT is for. Description evidence decides the
  // family, and a role with none still counts — 18% of postings carry no
  // description at all.
  {
    category: 'generic_engineering',
    pattern:
      // 'chief' and 'master' are deliberately absent. A trial run matched two
      // "Chief Engineer" postings, which in buildings, hotels and shipping is
      // the head of maintenance — the exact kind of false positive that would
      // make the whole filter untrustworthy.
      /^(senior|sr\.?|staff|principal|lead)?\s*(software\s+)?engineer(ing)?\s*(i{1,3}|iv|v|\d)?$|^(senior|sr\.?|staff|principal|lead)\s+engineer\b|\b(applications?\s+engineer|technical\s+specialist|technology\s+specialist)\b/i,
    fallback: 'software',
  },
];

export interface AdjacentMatch {
  category: AdjacentCategory;
  family: Family;
  /** Short human explanation, stored for debugging alongside the row. */
  reason: string;
}

/**
 * Decides whether a posting the core rules refused is worth surfacing anyway.
 *
 * Only ever called for a job `classifyRole` gave no family — this widens the
 * net, it never overrides a decision already made.
 */
export function classifyAdjacent(job: NormalizedJob): AdjacentMatch | null {
  const title = job.title;
  if (NEVER_ADJACENT.test(title)) return null;
  if (HARDWARE_ENGINEERING.test(title)) return null;
  if (NOT_A_TECH_ROLE.test(title)) return null;

  // Same normalisation the family rules use, for the same reason: 'Full-Stack'
  // and 'Engineering' must match patterns written as 'full stack' and 'engineer'.
  const forMatch = title.replace(/\bengineering\b/gi, 'engineer').replace(/-/g, ' ').trim();

  for (const rule of RULES) {
    if (!rule.pattern.test(forMatch)) continue;

    // "Systems Engineer" is a title two unrelated professions share, and a
    // blocklist can only name the disciplines someone remembered. This one rule
    // therefore demands positive evidence that the role is an IT one.
    if (rule.category === 'systems_engineering') {
      const haystack = `${title} ${(job.descriptionText ?? '').slice(0, 4000)}`;
      if (!IT_ACRONYM.test(title) && !IT_SIGNAL.test(haystack)) continue;
    }

    // The two HRIS rules are family-authoritative. Letting description scores
    // decide would file a payroll manager as `data` on the strength of one
    // mention of SQL, and HRIS roles carry no skill fingerprint by design.
    if (rule.category === 'hris_platform' || rule.category === 'hris_operations') {
      const why =
        rule.category === 'hris_platform'
          ? (HRIS_NON_HR_MODULE.test(title)
              ? 'Adjacent (hris_platform); HR platform, non-HR module'
              : 'Adjacent (hris_platform); vendor product outside the core rules')
          : 'Adjacent (hris_operations); payroll or benefits management, not systems';
      return { category: rule.category, family: 'hris', reason: why };
    }

    // Let the description pick the family when it says anything at all. A
    // "Business Systems Analyst" describing Snowflake and dbt is a data role;
    // one describing Kubernetes is a cloud role. The fallback is only for the
    // silent ones.
    const scores = debugScores(job);
    let best: Family | null = null;
    let bestScore = 0;
    for (const [family, score] of Object.entries(scores) as [Family, number][]) {
      if (score > bestScore) { best = family; bestScore = score; }
    }

    const family = best ?? rule.fallback;
    const reason = best
      ? `Adjacent (${rule.category}); description scored ${bestScore} for ${family}`
      : `Adjacent (${rule.category}); no description evidence, filed under ${family}`;
    return { category: rule.category, family, reason };
  }

  return null;
}
