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
  | 'rippling';

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

export class AtsFetchError extends Error {
  constructor(
    message: string,
    readonly provider: AtsProvider,
    readonly token: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AtsFetchError';
  }
}
