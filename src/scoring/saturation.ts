import type { AtsProvider, NormalizedJob } from '../ats/types.js';

/**
 * Saturation scoring, first cut.
 *
 * Output is 0..100 where HIGHER MEANS LESS CONTESTED. This is not a fit score —
 * it says nothing about whether the user can do the job. Fit is a separate gate
 * applied after this, because blending the two corrupts both: a perfect-fit role
 * with 3,000 applicants and a zero-fit role with 4 would score identically.
 *
 * Every weight below is a prior, not a measurement. Phase 5 replaces them with
 * coefficients learned from real outcomes; until then they are honest guesses
 * with the reasoning written down so they can be argued with.
 */

export const SCORER_VERSION = '0.1.0';

export interface ScoreComponents {
  discoveryFriction: number;
  applicationFriction: number;
  qualificationFriction: number;
  desirabilityDiscount: number;
  freshness: number;
  ghostRisk: number;
}

export interface ScoredJob {
  job: NormalizedJob;
  provider: AtsProvider;
  boardToken: string;
  companyName: string;
  score: number;
  components: ScoreComponents;
  reasons: string[];
}

const WEIGHTS: Record<keyof Omit<ScoreComponents, 'ghostRisk'>, number> = {
  // Weighted highest because it is the axis with the largest observed spread:
  // remote SWE openings numbered ~5.5k against ~21k on-site, while drawing an
  // unbounded global applicant pool instead of a commutable one.
  desirabilityDiscount: 0.3,
  discoveryFriction: 0.25,
  qualificationFriction: 0.2,
  applicationFriction: 0.15,
  freshness: 0.1,
};

/**
 * How much traffic a board gets before anyone applies.
 *
 * Greenhouse, Lever and Ashby power the startup boards that every aggregator
 * scrapes and every job-seeker newsletter republishes. Breezy and Personio are
 * small-company and EU-heavy, and are syndicated far less, so an opening there
 * is seen by fewer people for the same underlying role.
 */
const PROVIDER_DISCOVERY: Record<AtsProvider, number> = {
  greenhouse: 0.3,
  lever: 0.35,
  ashby: 0.4,
  smartrecruiters: 0.6,
  workable: 0.65,
  // Enterprise Workday boards are rarely syndicated and rarely browsed by the
  // tech-startup job-seeking crowd, so the same role is seen by far fewer people.
  workday: 0.75,
  personio: 0.75,
  breezy: 0.85,
};

/**
 * Vendor-level application friction — high is GOOD here. Workday tops the scale
 * because applying means creating a per-tenant account and re-keying an entire
 * resume, which is where most human applicants give up.
 */
const PROVIDER_APPLICATION: Record<AtsProvider, number> = {
  greenhouse: 0.25,
  lever: 0.2,
  ashby: 0.2,
  breezy: 0.35,
  workable: 0.4,
  personio: 0.5,
  smartrecruiters: 0.55,
  workday: 1,
};

/** Metro areas with the deepest local applicant pools. */
const HUB_CITIES =
  /\b(san francisco|bay area|new york|nyc|london|berlin|bengaluru|bangalore|seattle|austin|toronto|amsterdam|singapore|dublin|paris|sydney|tel aviv|boston|los angeles|chicago|hyderabad|pune|noida|gurgaon|mumbai|delhi)\b/i;

/** Skills with a genuinely small qualified population, not merely unfashionable ones. */
const NICHE_SKILLS =
  /\b(cobol|mainframe|abap|sap\b|apex|elixir|clojure|erlang|ocaml|haskell|labview|verilog|vhdl|fpga|matlab|\bsas\b|fortran|delphi|perl|assembly|plc|scada|autocad|solidworks|revit|catia|ansys|actuarial|hl7|fhir|dicom|iso 13485|\bgmp\b|\bgxp\b|hipaa|\baml\b|\bkyc\b|basel|solvency)\b/i;

const CREDENTIALS =
  /\b(security clearance|ts\/sci|top secret|public trust|cissp|cisa|cpa\b|\bcfa\b|\bpe\b license|registered nurse|\brn\b license|pharmd|\bmd\b required|licensed|certification required|board certified)\b/i;

/** Phrases that mark an evergreen pipeline rather than a real opening. */
const EVERGREEN =
  /\b(always accepting|general application|talent (pool|pipeline|community)|future opportunities|speculative|open application|expression of interest|we are always)\b/i;

const STAFFING =
  /\b(staffing|recruitment agency|consultancy|c2c|corp to corp|w2 only|multiple positions|various clients)\b/i;

const clamp = (n: number) => Math.max(0, Math.min(1, n));

function ageDays(postedAt: Date | undefined, now: number): number | undefined {
  if (!postedAt) return undefined;
  return (now - postedAt.getTime()) / 86_400_000;
}

function scoreDesirability(job: NormalizedJob, reasons: string[]): number {
  let score: number;
  switch (job.remoteType) {
    case 'fully_remote':
      score = 0.12;
      reasons.push('Fully remote — largest applicant pool of any format');
      break;
    case 'hybrid':
      score = 0.68;
      reasons.push('Hybrid — applicant pool limited to commutable candidates');
      break;
    case 'on_site':
      score = 0.85;
      reasons.push('On-site — geographically capped competition');
      break;
    default:
      score = 0.5;
  }

  const haystack = `${job.locationRaw ?? ''} ${job.city ?? ''} ${job.region ?? ''}`;
  if (HUB_CITIES.test(haystack)) {
    score -= 0.2;
    reasons.push('Major tech hub — deep local applicant pool');
  } else if (job.remoteType === 'on_site' || job.remoteType === 'hybrid') {
    score += 0.1;
    reasons.push('Secondary market — thinner local competition');
  }

  return clamp(score);
}

function scoreQualification(job: NormalizedJob, reasons: string[]): number {
  let score = 0.4;
  const text = `${job.title} ${job.descriptionText ?? ''}`;

  switch (job.seniority) {
    case 'entry':
      score = 0.08;
      reasons.push('Entry level — the most contested tier in the market');
      break;
    case 'senior':
      score = 0.6;
      break;
    case 'staff':
    case 'principal':
      score = 0.8;
      reasons.push('Staff/principal — small qualified population');
      break;
    case 'lead':
    case 'director':
    case 'executive':
      score = 0.75;
      break;
  }

  if (NICHE_SKILLS.test(text)) {
    score += 0.25;
    reasons.push('Niche technology — very few qualified applicants');
  }
  if (CREDENTIALS.test(text)) {
    score += 0.2;
    reasons.push('Hard credential or clearance gate');
  }

  return clamp(score);
}

function scoreDiscovery(
  provider: AtsProvider,
  boardSize: number,
  reasons: string[],
): number {
  let score = PROVIDER_DISCOVERY[provider] ?? 0.5;

  // Tiny boards belong to companies nobody is watching; huge boards belong to
  // employers with their own inbound brand gravity.
  if (boardSize <= 10) {
    score += 0.12;
    reasons.push('Small board — low-traffic employer');
  } else if (boardSize > 500) {
    score -= 0.1;
    reasons.push('Very large employer — high inbound volume');
  }

  return clamp(score);
}

function scoreApplication(
  provider: AtsProvider,
  job: NormalizedJob,
  reasons: string[],
): number {
  let score = PROVIDER_APPLICATION[provider] ?? 0.4;
  const text = job.descriptionText ?? '';

  // High friction is a FEATURE here: humans abandon these, automation does not.
  if (/\bcover letter\b/i.test(text)) {
    score += 0.2;
    reasons.push('Cover letter required — high human drop-off');
  }
  if (/\b(work sample|take[- ]home|portfolio|writing sample|assessment)\b/i.test(text)) {
    score += 0.15;
    reasons.push('Work sample required — high human drop-off');
  }

  return clamp(score);
}

function scoreFreshness(age: number | undefined, reasons: string[]): number {
  if (age === undefined) return 0.4;
  if (age <= 3) {
    reasons.push('Posted within 3 days — ahead of the applicant wave');
    return 1;
  }
  if (age <= 14) return 0.7;
  if (age <= 45) return 0.4;
  if (age <= 90) return 0.2;
  return 0.05;
}

/**
 * Probability this is not a real, fillable opening.
 *
 * Without this the feed degrades into ghost jobs: an opening nobody applies to
 * is very often an opening that does not exist. This is the counterweight that
 * keeps "unsaturated" from collapsing into "fake".
 */
function scoreGhostRisk(job: NormalizedJob, age: number | undefined, reasons: string[]): number {
  let risk = 0;
  const text = `${job.title} ${job.descriptionText ?? ''}`;

  if (EVERGREEN.test(text)) {
    risk += 0.6;
    reasons.push('Evergreen pipeline posting — may not be a real opening');
  }
  if (STAFFING.test(text)) {
    risk += 0.25;
    reasons.push('Agency or staffing listing');
  }
  if (age !== undefined && age > 120) {
    risk += 0.4;
    reasons.push(`Open ${Math.round(age)} days — stale or perpetually relisted`);
  } else if (age !== undefined && age > 60 && job.salaryMin === undefined) {
    risk += 0.15;
  }

  return clamp(risk);
}

export interface ScoreInput {
  job: NormalizedJob;
  provider: AtsProvider;
  boardToken: string;
  companyName: string;
  boardSize: number;
  now?: number;
}

export function scoreJob(input: ScoreInput): ScoredJob {
  const { job, provider, boardSize } = input;
  const now = input.now ?? Date.now();
  const age = ageDays(job.postedAt, now);
  const reasons: string[] = [];

  const components: ScoreComponents = {
    desirabilityDiscount: scoreDesirability(job, reasons),
    discoveryFriction: scoreDiscovery(provider, boardSize, reasons),
    qualificationFriction: scoreQualification(job, reasons),
    applicationFriction: scoreApplication(provider, job, reasons),
    freshness: scoreFreshness(age, reasons),
    ghostRisk: scoreGhostRisk(job, age, reasons),
  };

  const weighted =
    components.desirabilityDiscount * WEIGHTS.desirabilityDiscount +
    components.discoveryFriction * WEIGHTS.discoveryFriction +
    components.qualificationFriction * WEIGHTS.qualificationFriction +
    components.applicationFriction * WEIGHTS.applicationFriction +
    components.freshness * WEIGHTS.freshness;

  // Ghost risk suppresses rather than zeroes: a suspicious posting should sink,
  // but stay inspectable instead of vanishing from the feed silently.
  const score = Math.round(weighted * (1 - components.ghostRisk * 0.8) * 100);

  return {
    job,
    provider,
    boardToken: input.boardToken,
    companyName: input.companyName,
    score,
    components,
    reasons,
  };
}
