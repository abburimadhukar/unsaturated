import type { NormalizedJob } from '../ats/types.js';
import { debugScores } from './families.js';

/**
 * The review pile: postings nothing claimed and nothing rejected.
 *
 * Not a kind of job — a queue. "Unsorted" describes our knowledge, not the
 * work, which is why it is kept out of every default view and only appears when
 * it is asked for by name. It exists so a human can look at what the rules are
 * missing and say where it belongs, which is more reliable than me guessing.
 *
 * The gate matters, because the raw pile is unusable. 374,272 postings across
 * 35,512 distinct titles fell through the rules, and reviewing even the top 500
 * of those covers under half of them. Almost all of it is chefs, machinists and
 * nurses. So this admits a posting only when something about it suggests a
 * technical role that the strict rules fumbled — leaving a pile worth opening
 * rather than a second corpus.
 *
 * Measured on a live shard: 801 read, 704 dropped, 441 unmatched by any rule
 * and not adjacent, and 92 through this gate. The first draft of that gate was
 * dominated by physical security — Security Officer, Security Supervisor, Event
 * Security — because "security" is a technical word in the wrong context. Those
 * are named below, plural included: the earlier blocklist said `security
 * officer` and matched none of the "Security Officers" postings, because the
 * word boundary lands after "officer" and the s is not it.
 */

/**
 * Never in the pile, whatever else the title says.
 *
 * Two groups: other engineering disciplines, and jobs whose titles borrow a
 * technical word for entirely untechnical work.
 */
const NEVER_UNSORTED =
  /\b(mechanical|electrical|electronics|civil|chemical|process|manufactur\w*|production|quality|industrial|structural|aerospace|automotive|biomedical|environmental|geotechnical|mining|petroleum|drilling|welding|hvac|plumbing|marine|nuclear|packaging|plant|facilities|field service|construction|highway|survey\w*|maintenance)\b/i
;

/**
 * Physical security, which is the single largest source of false positives.
 *
 * Deliberately separate from the list above and deliberately generous: guard
 * work is posted in enormous volume under dozens of phrasings, and one of these
 * postings in the review pile costs more attention than it is worth.
 */
const PHYSICAL_SECURITY =
  /\b(security\s+(officers?|guards?|supervisors?|site\s+lead|manager|managers|patrol|screening|licen[cs]e)|event\s+security|crowd\s+control|loss\s+prevention|door\s+supervisor|close\s+protection)\b/i;

/** Jobs that are simply not ours, however they are worded. */
const NOT_OUR_WORLD =
  /\b(nurse|nursing|clinical|physician|pharmac\w*|dental|veterinar\w*|therapist|teacher|lecturer|professor|chef|cook|barista|cashier|waiter|waitress|driver|warehouse|forklift|janitor|custodian|cleaner|labour\w*|farm|retail\s+associate|store\s+manager)\b/i;

/**
 * A word suggesting the posting is technical.
 *
 * Loose on purpose — this is a queue for a human to judge, so a false positive
 * costs a glance and a false negative costs a job forever. "security" is absent:
 * it earns its place only through the guarded patterns above.
 */
const LOOKS_TECHNICAL =
  /\b(engineer|engineering|developer|architect|administrator|programmer|analyst|scientist|technical|technology|systems?|software|cloud|azure|aws|gcp|platform|infrastructure|network|database|integration|automation|devops|sre|\bit\b|digital|application|api|web|mobile|\bqa\b|test|cyber|forensics|erp|crm|saas|salesforce|dynamics|sharepoint|power\s+platform)\b/i;

/**
 * Should this unclaimed posting go in the review pile?
 *
 * Only ever called where the core rules found no family, no exclusion rule
 * fired, and the adjacent rules did not claim it either — so it can never
 * override a decision already made.
 */
export function belongsInReviewPile(job: NormalizedJob): boolean {
  const title = job.title;
  if (NEVER_UNSORTED.test(title)) return false;
  if (PHYSICAL_SECURITY.test(title)) return false;
  if (NOT_OUR_WORLD.test(title)) return false;

  if (LOOKS_TECHNICAL.test(title)) return true;

  // No technical word in the title, but the description named a real tool. A
  // posting whose body mentions Kubernetes or Snowflake is worth a glance
  // whatever it calls itself.
  const scores = debugScores(job);
  return Math.max(...Object.values(scores)) > 0;
}
