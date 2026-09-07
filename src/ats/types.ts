/**
 * Canonical job shape. Every ATS adapter normalizes into this, so scoring and
 * matching never need to know which vendor a posting came from.
 */

export type RemoteType = 'fully_remote' | 'hybrid' | 'on_site';

export type AtsProvider =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'smartrecruiters'
  | 'breezy'
  | 'personio'
  | 'workday'
  | 'bamboohr'
  | 'ukg'
  | 'recruitee'
  | 'teamtailor'
  | 'rippling'
  | 'usajobs'
  | 'socrata';

export interface BoardRef {
  provider: AtsProvider;
  /** Vendor tenant identifier, e.g. 'lyrahealth' for jobs.lever.co/lyrahealth. */
  token: string;
  extra?: Record<string, string>;
}

export interface NormalizedJob {
  externalId: string;
  title: string;
  descriptionText?: string;
  descriptionHtml?: string;

  locationRaw?: string;
  country?: string;
  region?: string;
  city?: string;
  remoteType?: RemoteType;

  employmentType?: string;
  department?: string;
  team?: string;
  seniority?: string;

  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;

  applyUrl?: string;
  listingUrl?: string;

  /**
   * The ATS's own publish timestamp. This is the single most valuable field the
   * direct-ingest path buys us: aggregators overwrite it with their crawl date,
   * which destroys both the freshness signal and repost detection.
   */
  postedAt?: Date;

  /** Untouched vendor payload, retained so re-normalization never needs a re-crawl. */
  raw: unknown;
}

export interface AtsAdapter {
  provider: AtsProvider;
  /** Human-readable endpoint pattern, surfaced in errors and docs. */
  endpointPattern: string;
  /** True when the vendor rejects non-browser user agents and needs a browser tier. */
  requiresBrowser?: boolean;
  fetchJobs(board: BoardRef, ctx: FetchContext): Promise<NormalizedJob[]>;
}

export interface FetchContext {
  userAgent: string;
  /** Milliseconds before a single board fetch is abandoned. */
  timeoutMs: number;
  /** Stops paginating once this many jobs are collected. Keeps interactive
   *  callers responsive against enterprise boards with thousands of postings. */
  maxJobs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Why a board did not answer — and it is not one question but two.
 *
 * 'gone'    the board really is not there: 404, 410, or a tenant that no
 *           longer exists. Counting these toward retirement is the point of
 *           retirement.
 *
 * 'refused' the vendor declined to serve us right now: 429, a 5xx, a timeout,
 *           a dropped connection. Says nothing whatever about the board.
 *
 * The crawler used to have only `ok: boolean`, so both landed in the same
 * bucket and a rate limit walked a live company toward deactivation. It did:
 * 2,185 of 2,263 retired boards carried an HTTP 429, against 16 that were
 * genuinely 404. Six sampled at random answered 200 with 3 to 86 live jobs
 * still on them.
 *
 * Splitting the two makes that class of loss structurally impossible rather
 * than merely unlikely, which is why it is a type and not a comment.
 */
export type FetchFailure = 'gone' | 'refused';

export class AtsFetchError extends Error {
  constructor(
    message: string,
    readonly provider: AtsProvider,
    readonly token: string,
    readonly status?: number,
    /** Defaults to 'refused': the safe answer when we cannot tell. */
    readonly failure: FetchFailure = 'refused',
  ) {
    super(message);
    this.name = 'AtsFetchError';
  }
}

/**
 * Statuses that mean the board is genuinely gone.
 *
 * Deliberately short. 403 is absent because it is nearly always user-agent
 * filtering rather than a missing board, and 401 because it means the endpoint
 * wants credentials, not that the company stopped hiring.
 */
export function failureKindFor(status: number | undefined): FetchFailure {
  if (status === 404 || status === 410) return 'gone';
  return 'refused';
}
