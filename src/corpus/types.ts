import type { AtsProvider } from '../ats/types.js';
import type { Family } from '../taxonomy/families.js';

/**
 * Shapes and constants the web app needs, with no Node dependencies.
 *
 * Split out of live.ts because that module reads the board list and the build
 * snapshot off disk, and importing anything from it — even a constant — dragged
 * `node:fs` into the bundle. That is merely wasteful on a Node host and fatal on
 * Cloudflare Workers, which have no filesystem.
 *
 * live.ts re-exports these, so the crawler and CLIs are unaffected.
 */

/** Postings older than this are dropped at ingest — three weeks. */
export const MAX_AGE_DAYS = 21;

export interface FeedJob {
  key: string;
  title: string;
  company: string;
  provider: AtsProvider;
  location: string | null;
  country: string | null;
  remoteType: string | null;
  seniority: string | null;
  employmentType: string | null;
  department: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  ageDays: number | null;
  applyUrl: string | null;

  saturation: number;
  components: Record<string, number>;
  reasons: string[];

  inScope: boolean;
  family: Family | null;
  /** AI/ML role, whatever its family. */
  ai: boolean;
  matchedSkills: string[];
  skillScore: number;
}

export interface BoardHealth {
  company: string;
  provider: AtsProvider;
  /**
   * The board's own token. Company names are not unique — 13 of them run two
   * boards each — so closing stale jobs has to key on provider+token or a
   * healthy board authorises closing a failing sibling's postings.
   */
  token?: string;
  jobs: number;
  kept: number;
  /** Descriptions fetched by the backfill pass. */
  described?: number;
  ms: number;
  error?: string;
}

export interface Feed {
  jobs: FeedJob[];
  boards: BoardHealth[];
  refreshedAt: string;
  /** 'snapshot' = baked at build time; 'live' = crawled in this process. */
  source?: 'snapshot' | 'live';
  /**
   * Total jobs seen by the crawl, including out-of-scope ones. The snapshot keeps
   * only in-scope roles, so this preserves the honest "scanned" figure.
   */
  scanned?: number;
}

export type SortKey = 'newest' | 'salary' | 'fit';

export interface FeedQuery {
  cloudOnly?: boolean;
  remote?: string;
  seniority?: string;
  family?: string;
  provider?: string;
  country?: string;
  q?: string;
  employmentType?: string;
  minFit?: number;
  postedWithinDays?: number;
  minSalary?: number;
  hasSalary?: boolean;
  ai?: boolean;
  hideGhosts?: boolean;
  hideSeen?: boolean;
  seenKeys?: Set<string>;
  /** Keep rows whose value is unknown. True unless explicitly disabled. */
  includeUnknown?: boolean;
  skills?: string[];
  sort?: SortKey;
  minSaturation?: number;
}
