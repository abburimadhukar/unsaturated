/**
 * Quiet roles — the same work under a title nobody searches for.
 *
 * People find jobs by typing a title into a box. If a posting is not called what
 * they typed, they never see it, and it collects a fraction of the applications
 * an identical job would collect under the popular name. That is the entire idea
 * here: not rare work, not worse work — the same work, filed under a label the
 * crowd does not query.
 *
 * The corpus says the crowd is funnelling into a very small set of names. Each
 * family holds thousands of distinct titles and the top twenty cover only a
 * fifth to a quarter of the postings:
 *
 *   cloud     9,140 jobs · 4,856 distinct titles · top 20 = 19% · 3,805 used once
 *   software 14,167 jobs · 6,906 distinct titles · top 20 = 22% · 5,481 used once
 *   data      7,273 jobs · 3,928 distinct titles · top 20 = 26% · 3,191 used once
 *   hris      2,481 jobs · 1,308 distinct titles · top 20 = 29% · 1,068 used once
 *
 * The published research says what the crowding costs: the average opening now
 * draws 200-250 applications and entry-level often 400+, while remote postings
 * pull 2.5-3.4x the applicants of an identical on-site role — on LinkedIn, 16%
 * of postings taking 53% of all applications.
 *
 * GLOBAL, not per family. This was the first thing measured wrong: with a
 * per-family list, 88 postings titled plain "Software Engineer" classified as
 * cloud sailed through the cloud filter, because "software engineer" only
 * appeared on software's list. A magnet is a magnet wherever the posting lands.
 */

/**
 * The names people actually type.
 *
 * Drawn from the crowded head of each family in the live corpus rather than
 * invented, then widened with the spellings employers use for the same role
 * ("front end" / "frontend" / "front-end"). Deliberately short: this list is
 * meant to name the motorway, not every road on it. Everything not on it is
 * quiet, so a wrong ENTRY here silently hides good postings, while a missing
 * entry merely lets a popular title through — the cheaper mistake by far.
 */
export const MAGNET_TITLES: readonly string[] = [
  // The universal ones. "software engineer" alone is 1,272 postings.
  'software engineer',
  'software developer',
  'software development engineer',
  'full stack engineer',
  'full stack developer',
  'fullstack engineer',
  'backend engineer',
  'back end engineer',
  'backend developer',
  'frontend engineer',
  'front end engineer',
  'frontend developer',
  'front end developer',
  'web developer',
  'mobile engineer',
  'ios engineer',
  'android engineer',
  'engineering manager',
  // Cloud and infrastructure.
  'devops engineer',
  'devops',
  'cloud engineer',
  'cloud architect',
  'site reliability engineer',
  'platform engineer',
  'infrastructure engineer',
  'network engineer',
  'security engineer',
  'solutions architect',
  'solution architect',
  'solutions engineer',
  'systems engineer',
  // Data.
  'data engineer',
  'data scientist',
  'data analyst',
  'business analyst',
  'analytics engineer',
  'machine learning engineer',
  'business intelligence analyst',
  'data architect',
  // AI, the current magnet.
  'ai engineer',
  'ml engineer',
  'aiml engineer',
  // HR systems.
  'workday analyst',
  'workday consultant',
  'hris analyst',
  'hris manager',
  'payroll specialist',
  'payroll manager',
  'hr analyst',
];

/**
 * Abbreviations that are magnets on their own.
 *
 * Kept apart from the phrases above because they must match as whole words —
 * "sre" inside "presrelease" is not a title, and "\bsre\b" is the only spelling
 * that says so.
 */
export const MAGNET_ACRONYMS: readonly string[] = ['sre', 'sdet', 'swe'];

/**
 * The shared regular expression, as a string.
 *
 * Built here and used in two places — this module and the SQL that filters the
 * feed — because the filter has to run in the database. Querying 61,000 rows
 * into a Worker to drop nine tenths of them is exactly what the rest of this
 * codebase refuses to do.
 *
 * Two spellings of every phrase are accepted: the plain one and one where each
 * space may also be a hyphen, so "front end", "front-end" and "frontend" all
 * count as the same magnet. POSIX-compatible on purpose — Postgres and
 * JavaScript both have to read it.
 */
export const MAGNET_PATTERN: string = (() => {
  const phrases = MAGNET_TITLES.map((t) => t.split(' ').join('[ -]?'));
  const acronyms = MAGNET_ACRONYMS.map((a) => a);
  return `(^|[^a-z])(${[...phrases, ...acronyms].join('|')})([^a-z]|$)`;
})();

const MAGNET_RE = new RegExp(MAGNET_PATTERN, 'i');

/** True when the title is one of the names the crowd searches. */
export function isMagnetTitle(title: string): boolean {
  return MAGNET_RE.test(title.toLowerCase());
}

/**
 * Boards that every aggregator scrapes and every jobs newsletter republishes.
 *
 * Not a judgement about the employer — a posting on Greenhouse is seen by far
 * more people than the identical posting on a mid-market HR suite, which is the
 * whole reason the crawler was extended to those suites in the first place.
 */
export const SYNDICATED_PROVIDERS: readonly string[] = ['greenhouse', 'lever', 'ashby'];

export interface QuietInput {
  title: string;
  provider: string;
  remoteType?: string | null;
  seniority?: string | null;
}

/**
 * Why this posting is quieter than its neighbours, in the order that matters.
 *
 * Every line is derived from a column we already hold — nothing here is
 * estimated, and nothing is invented. A posting that earns no line beyond the
 * title still belongs on the page; it simply has one reason rather than four.
 */
export function quietReasons(job: QuietInput): string[] {
  const out: string[] = ['Titled something people do not search for'];

  if (job.remoteType === 'on_site') out.push('On-site — competition capped by geography');
  else if (job.remoteType === 'hybrid') out.push('Hybrid — commutable candidates only');

  if (!SYNDICATED_PROVIDERS.includes(job.provider)) {
    out.push('Mid-market board — rarely syndicated');
  }
  // Workday and UKG both demand a per-tenant account and a re-keyed resume,
  // which is where most human applicants give up.
  if (job.provider === 'workday' || job.provider === 'ukg') {
    out.push('Application needs an account — high drop-off');
  }
  if (job.seniority && ['staff', 'principal', 'lead'].includes(job.seniority)) {
    out.push('Staff or above — small qualified pool');
  }

  return out;
}

/**
 * A rough "how quiet" ordering, 0-100.
 *
 * Deliberately NOT the saturation scorer in src/scoring — that one is richer,
 * reads the description, and is computed at crawl time. This is the part that
 * can be recomputed from a stored row alone, so the page can rank without
 * waiting for a new column and a full crawl to fill it.
 */
export function quietScore(job: QuietInput): number {
  let n = 40;
  if (job.remoteType === 'on_site') n += 25;
  else if (job.remoteType === 'hybrid') n += 15;
  else if (job.remoteType === 'fully_remote') n -= 15;

  if (!SYNDICATED_PROVIDERS.includes(job.provider)) n += 15;
  if (job.provider === 'workday' || job.provider === 'ukg') n += 10;

  if (job.seniority === 'entry') n -= 20;
  else if (job.seniority && ['staff', 'principal', 'lead'].includes(job.seniority)) n += 10;

  return Math.max(0, Math.min(100, n));
}
