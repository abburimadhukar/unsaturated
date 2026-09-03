import { db } from '../db/supabase.js';
import { MAX_AGE_DAYS, type FeedJob, type FeedQuery } from './live.js';
import { toFeedJob, type JobRow } from './db-feed.js';

/**
 * Feed queries answered by the database.
 *
 * The site used to load every open job into memory and filter in JavaScript.
 * That was fine at 4,000 rows and stopped being fine at 16,754: a full read is
 * ~13.7 MB of JSON to render 50 jobs, and Supabase's free tier allows 5 GB of
 * egress a month — roughly 365 cache misses before it is gone. Filtering,
 * sorting and paging now happen in Postgres and only the page comes back, which
 * is about 37 KB.
 *
 * The in-memory path in live.ts is kept as the fallback. A clean checkout with
 * no database, and a database outage, both still serve the build snapshot.
 */

export interface FeedPage {
  jobs: FeedJob[];
  total: number;
}

export interface Facets {
  family: Record<string, number>;
  country: Record<string, number>;
  remote: Record<string, number>;
  provider: Record<string, number>;
  seniority: Record<string, number>;
  /** Jobs whose country could not be decoded — its own dropdown option. */
  countryUnknown: number;
  inScope: number;
  /** When the corpus was last written, not when this request was served. */
  refreshedAt: string | null;
  /** Jobs the crawl READ, which is far more than the roles it kept. */
  scanned: number;
}

function cutoffIso(): string {
  return new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
}

/** null rather than '' — the function treats null as "no filter". */
const orNull = (v: string | undefined) => (v && v.trim() ? v : null);

export async function queryFeedFromDb(
  f: FeedQuery,
  offset: number,
  limit: number,
): Promise<FeedPage | null> {
  try {
    const { data, error } = await db().rpc('feed_page', {
      p_cutoff: cutoffIso(),
      p_in_scope: f.cloudOnly !== false,
      p_family: orNull(f.family),
      p_country: orNull(f.country),
      p_remote: orNull(f.remote),
      p_seniority: orNull(f.seniority),
      p_employment: orNull(f.employmentType),
      p_provider: orNull(f.provider),
      p_q: orNull(f.q),
      p_has_salary: f.hasSalary === true,
      p_min_salary: f.minSalary ?? null,
      p_within_days: f.postedWithinDays ?? null,
      p_ai: f.ai === true,
      p_hide_ghosts: f.hideGhosts === true,
      // Unknowns are kept unless explicitly excluded, matching the rule the rest
      // of the app follows: a job we could not classify is not evidence it
      // belongs elsewhere.
      p_keep_unknown: f.includeUnknown !== false,
      p_sort: f.sort ?? 'newest',
      p_offset: offset,
      p_limit: limit,
    });

    if (error) {
      // Never fatal: the caller falls back to the in-memory corpus.
      console.error('feed_page failed:', error.message);
      return null;
    }
    const body = data as { total?: number; rows?: JobRow[] } | null;
    if (!body || !Array.isArray(body.rows)) return null;

    return {
      total: body.total ?? body.rows.length,
      jobs: body.rows.map((r) => toFeedJob(r)),
    };
  } catch (err) {
    console.error('feed_page unavailable:', err);
    return null;
  }
}

export async function facetsFromDb(f: FeedQuery): Promise<Facets | null> {
  try {
    const { data, error } = await db().rpc('feed_facets', {
      p_cutoff: cutoffIso(),
      p_in_scope: f.cloudOnly !== false,
      p_hide_ghosts: f.hideGhosts === true,
    });
    if (error) {
      console.error('feed_facets failed:', error.message);
      return null;
    }
    return (data as Facets) ?? null;
  } catch (err) {
    console.error('feed_facets unavailable:', err);
    return null;
  }
}
