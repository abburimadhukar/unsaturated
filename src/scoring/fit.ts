
/**
 * Fit is a GATE, not a ranker.
 *
 * Saturation orders the feed; fit only decides whether a job is eligible to be
 * in it. Keeping them separate is deliberate: blended into one number, a
 * perfect-fit role with 3,000 applicants and a zero-fit role with 4 applicants
 * score the same, and you can no longer tell why anything ranked where it did.
 */

export interface FitResult {
  /** 0..1 — share of the job's cloud skills the candidate already has. */
  score: number;
  /**
   * False when the job carried no description to match against. The UI must
   * show "unknown" rather than a number in that case: SmartRecruiters and
   * Workable are listing-only feeds, so roughly 300 of the current corpus have
   * nothing to score, and printing a neutral 0.5 as "50% fit" would be
   * presenting a placeholder as a measurement.
   */
  known: boolean;
  /**
   * How many skills the job actually named. A 100% match against one detected
   * skill is far weaker evidence than 100% against ten, and without this the
   * two are indistinguishable — a NOC listing mentioning only "Observability"
   * outranks a Kubernetes platform role matching five.
   */
  basis: number;
  /** Ranking score: the ratio discounted by how thin the evidence is. */
  confidence: number;
  have: string[];
  missing: string[];
}

/** Below this many named skills, a ratio is not yet trustworthy on its own. */
const FULL_EVIDENCE = 5;

/**
 * Takes only the skills a job named, rather than a whole classification object.
 * Fit does not care which family a role belongs to — decoupling this keeps the
 * scorer working unchanged as the taxonomy grows.
 */
export function scoreFit(candidateSkills: string[], job: { matchedSkills: string[] }): FitResult {
  const required = job.matchedSkills;
  if (required.length === 0) {
    return { score: 0.5, known: false, basis: 0, confidence: 0, have: [], missing: [] };
  }

  const owned = new Set(candidateSkills.map((s) => s.toLowerCase()));
  const have = required.filter((s) => owned.has(s.toLowerCase()));
  const missing = required.filter((s) => !owned.has(s.toLowerCase()));

  const score = have.length / required.length;
  return {
    score,
    known: true,
    basis: required.length,
    confidence: score * Math.min(1, required.length / FULL_EVIDENCE),
    have,
    missing,
  };
}
