import { getAdapter } from '../ats/adapters/index.js';
import { discoverWorkdaySite } from '../ats/adapters/workday.js';
import { AtsFetchError, type AtsProvider, type BoardRef } from '../ats/types.js';
import { config } from '../config.js';
import { slugCandidates } from './slugs.js';

/**
 * Verifies whether a candidate token is a real board on a given provider.
 *
 * This is polite discovery, not a dictionary attack: a bounded number of slug
 * guesses per company, low concurrency, honest user-agent, and a 404 is simply
 * recorded as "not this provider" rather than retried.
 */

export interface Discovery {
  company: string;
  provider: AtsProvider;
  token: string;
  jobCount: number;
  /** Workday needs host + site alongside the tenant token. */
  extra?: Record<string, string>;
}

export interface ProbeStats {
  companiesTried: number;
  requestsMade: number;
  found: Discovery[];
  notFound: string[];
}

/** Cheapest-first: providers whose boards return fastest are probed earliest. */
const PROBE_ORDER: AtsProvider[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  'breezy',
  'personio',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryBoard(
  provider: AtsProvider,
  token: string,
): Promise<{ ok: boolean; jobCount: number }> {
  const ref: BoardRef = { provider, token };
  try {
    const jobs = await getAdapter(provider).fetchJobs(ref, {
      userAgent: config.userAgent,
      timeoutMs: 12_000,
      // One page is enough to confirm the board exists.
      maxJobs: 1,
    });
    return { ok: true, jobCount: jobs.length };
  } catch (err) {
    if (err instanceof AtsFetchError) return { ok: false, jobCount: 0 };
    return { ok: false, jobCount: 0 };
  }
}

export async function discoverCompany(
  company: string,
  onRequest?: () => void,
  includeWorkday = true,
): Promise<Discovery | null> {
  const candidates = slugCandidates(company);

  for (const provider of PROBE_ORDER) {
    for (const token of candidates) {
      onRequest?.();
      const res = await tryBoard(provider, token);
      // Empty boards are real but useless, and an employer with zero postings
      // tells us nothing — only keep boards that actually have jobs.
      if (res.ok && res.jobCount > 0) {
        return { company, provider, token, jobCount: res.jobCount };
      }
      await sleep(config.delayMs);
    }
  }

  // Workday last: it is the most expensive probe (a shard × site-name matrix)
  // but it is also where enterprises live, so it is the one that matters most
  // for the on-site pocket the other providers cannot reach.
  if (includeWorkday) {
    for (const token of candidates.slice(0, 3)) {
      onRequest?.();
      const found = await discoverWorkdaySite(token);
      if (found) {
        return {
          company,
          provider: 'workday',
          token,
          jobCount: found.total,
          extra: { host: found.host, site: found.site, locale: found.locale },
        };
      }
      await sleep(config.delayMs);
    }
  }

  return null;
}

/** Runs discovery over a company list with a bounded worker pool. */
export async function discoverAll(
  companies: string[],
  concurrency = 4,
  onProgress?: (done: number, total: number, found: number) => void,
  includeWorkday = true,
): Promise<ProbeStats> {
  const stats: ProbeStats = {
    companiesTried: companies.length,
    requestsMade: 0,
    found: [],
    notFound: [],
  };

  let cursor = 0;
  let done = 0;

  const workers = Array.from({ length: Math.min(concurrency, companies.length) }, async () => {
    while (cursor < companies.length) {
      const company = companies[cursor++];
      if (company === undefined) break;

      // One malformed company name must never abort a run of hundreds. Before
      // this, a single throw rejected Promise.all and discarded every board
      // already discovered.
      let hit: Discovery | null = null;
      try {
        hit = await discoverCompany(company, () => {
          stats.requestsMade++;
        }, includeWorkday);
      } catch {
        hit = null;
      }
      if (hit) stats.found.push(hit);
      else stats.notFound.push(company);

      done++;
      onProgress?.(done, companies.length, stats.found.length);
    }
  });

  await Promise.all(workers);
  return stats;
}
