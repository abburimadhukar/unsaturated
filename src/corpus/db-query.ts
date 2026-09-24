import { db } from '../db/supabase.js';
import { MAX_AGE_DAYS, type FeedJob, type FeedQuery } from './live.js';
import { isTransientWriteError, toFeedJob, type JobRow } from './db-feed.js';

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
  /**
   * How many of the matched rows have no posting date, over the whole match
   * rather than the current page. The sort puts undated rows last, so counting
   * within the page reports zero until the caller has already scrolled past
   * them — which is how "past 24 hours" quietly showed four-day-old rows.
   */
  undated: number;
}

export interface Facets {
  family: Record<string, number>;
  country: Record<string, number>;
  remote: Record<string, number>;
  provider: Record<string, number>;
  seniority: Record<string, number>;
  /** python / other / unknown — which stack the role is built on. */
  stack: Record<string, number>;
  /** How many core vs adjacent roles the rest of the filters leave. */
  adjacent: Record<string, number>;
  /**
   * Counts per specialization for the family currently selected, keyed by the
   * normalised value, plus '__unknown__' for rows whose specialization is NULL.
   * With no family selected these span every family, which is why the UI only
   * shows the list once a family is chosen.
   */
  specialization: Record<string, number>;
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

/**
 * One page of the feed, and the total it came from.
 *
 * ONE RETRY, AND ONLY FOR A REFUSAL — the same rule as facetsFromDb below, and
 * for the same reason. Measured 17 Sep 2026: 44 calls in 24 hours were cancelled
 * by anon's 3-second statement timeout, clustered on crawl hours, and each one
 * reached a visitor as "job data is temporarily unavailable". The facets, which
 * already retried, were cancelled 3 times in the same window.
 */
export async function queryFeedFromDb(
  f: FeedQuery,
  offset: number,
  limit: number,
  opts: FacetOptions = {},
): Promise<FeedPage | null> {
  const attempt = opts.attempt ?? 0;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const client = opts.client ?? db();
  try {
    const { data, error } = await client.rpc('feed_page', {
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
      p_stack: orNull(f.stack),
      p_specialization: orNull(f.specialization),
      p_adjacent: orNull(f.adjacent),
    });

    if (error) {
      if (attempt === 0 && isTransientWriteError(error.message)) {
        console.warn(`feed_page refused, retrying once: ${error.message}`);
        await wait(FACET_RETRY_PAUSE_MS);
        return queryFeedFromDb(f, offset, limit, { ...opts, attempt: 1 });
      }
      // Never fatal: the caller answers 503 rather than hanging.
      console.error('feed_page failed:', error.message);
      return null;
    }
    const body = data as { total?: number; undated?: number; rows?: JobRow[] } | null;
    if (!body || !Array.isArray(body.rows)) return null;

    return {
      total: body.total ?? body.rows.length,
      undated: body.undated ?? 0,
      jobs: body.rows.map((r) => toFeedJob(r)),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt === 0 && isTransientWriteError(message)) {
      console.warn(`feed_page unavailable, retrying once: ${message}`);
      await wait(FACET_RETRY_PAUSE_MS);
      return queryFeedFromDb(f, offset, limit, { ...opts, attempt: 1 });
    }
    console.error('feed_page unavailable:', err);
    return null;
  }
}

const FACET_RETRY_PAUSE_MS = 150;

/**
 * `client` and `wait` are injected so the retry can be tested without a database.
 * Shared by queryFeedFromDb and facetsFromDb.
 */
export interface FacetOptions {
  /**
   * PromiseLike, not Promise: supabase-js returns a thenable query builder from
   * .rpc(), so a real client does not satisfy `Promise` structurally. Typing it
   * as Promise meant the only caller that needs to pass one — the snapshot
   * refresh, which must use the WRITE client for its 8-second timeout rather
   * than anon's 3 — could not be typed at all.
   */
  client?: { rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
  wait?: (ms: number) => Promise<void>;
  attempt?: number;
  /**
   * Read the stored snapshot before counting. True everywhere except the job
   * that WRITES the snapshot — which must compute fresh counts, and would
   * otherwise read back the copy it is about to replace and store it again.
   */
  snapshot?: boolean;
}

/**
 * Sidebar counts for the current query.
 *
 * The whole filter set goes through, because a facet has to reflect every other
 * active filter. Passing only scope and ghosts — as this did — left every count
 * computed over the entire corpus: selecting HRIS, all 336 of them, still
 * offered "United States (6,243)", and choosing a country left the family tabs
 * unchanged. Each facet still excludes its own dimension, which is what lets you
 * switch between options rather than seeing every unselected one as zero.
 *
 * ONE RETRY, AND ONLY FOR A REFUSAL.
 *
 * Measured 11 Sep 2026, 25 sequential calls against production: 24 answered and
 * one came back `canceling statement due to statement timeout`. 4%. The query
 * runs ~1.1s at the median against `anon`'s 3-second statement timeout, so it
 * does not have to be much unluckier than usual to be killed.
 *
 * That 4% costs more than it sounds. A caller cannot tell a refusal from an
 * empty corpus, because this returns null for both — and app/api/feed/route.ts
 * substitutes EMPTY facets for a null, so the page renders with every filter
 * count at zero and the total reading 0, with the jobs listed right beside it.
 * That breaks the project's first rule: a missing value shows as missing, never
 * as an invented number, and a zero here is an invented number.
 *
 * One attempt, not three. A retry costs a whole extra slow query on a path the
 * page is waiting for, so this trades ~4% of loads being WRONG for ~4% being
 * slower, which is the right way round. Anything still refused after that stays
 * null — the retry narrows the window, it does not close it, and the zeroed
 * fallback in the route is still there to be decided on.
 */
/**
 * True when nothing has been filtered — the view every visitor lands on.
 *
 * Every field here is one the facet counts depend on, which is why the list is
 * spelled out rather than derived: a new filter added to feed_facets and not
 * added here would be served the unfiltered counts, and wrong counts are worse
 * than slow ones. facet-snapshot.test.ts checks the two lists agree.
 *
 * `cloudOnly` and `includeUnknown` default to true and are only false when the
 * caller says so, which is why they are compared against false rather than
 * checked for absence.
 */
export function isUnfilteredQuery(f: FeedQuery): boolean {
  return (
    !f.family && !f.country && !f.remote && !f.seniority && !f.employmentType &&
    !f.provider && !f.q && !f.stack && !f.specialization && !f.adjacent &&
    f.hasSalary !== true && f.ai !== true && f.hideGhosts !== true &&
    f.minSalary === undefined && f.postedWithinDays === undefined &&
    f.cloudOnly !== false && f.includeUnknown !== false
  );
}

/**
 * How stale a stored snapshot may be before it is ignored.
 *
 * A crawl refreshes it every few hours. If crawls have been failing for a day
 * the corpus has stopped moving anyway, but the counts should not silently
 * describe a corpus nobody has checked since — falling back to a live count is
 * slower and correct, which is the right way round.
 */
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function facetsFromDb(f: FeedQuery, opts: FacetOptions = {}): Promise<Facets | null> {
  const attempt = opts.attempt ?? 0;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const client = opts.client ?? db();

  // The stored answer, for the one query shape that can use it.
  //
  // Read first and only on the default view. A miss costs one primary-key
  // lookup on a single-row table and falls through to the live count, so the
  // worst case is what this path already did.
  if (attempt === 0 && opts.snapshot !== false && !opts.client && isUnfilteredQuery(f)) {
    try {
      const { data, error } = await db()
        .from('facet_snapshot')
        .select('facets,computed_at')
        .eq('id', true)
        .maybeSingle();
      const row = data as { facets: Facets; computed_at: string } | null;
      if (!error && row?.facets) {
        const age = Date.now() - Date.parse(row.computed_at);
        if (Number.isFinite(age) && age >= 0 && age < SNAPSHOT_MAX_AGE_MS) return row.facets;
      }
    } catch {
      // Never fatal, and never retried: this is an optimisation in front of a
      // path that already works. Anything wrong here falls through to it.
    }
  }

  try {
    const { data, error } = await client.rpc('feed_facets', {
      p_cutoff: cutoffIso(),
      p_in_scope: f.cloudOnly !== false,
      p_hide_ghosts: f.hideGhosts === true,
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
      p_keep_unknown: f.includeUnknown !== false,
      p_stack: orNull(f.stack),
      p_specialization: orNull(f.specialization),
      p_adjacent: orNull(f.adjacent),
    });
    if (error) {
      if (attempt === 0 && isTransientWriteError(error.message)) {
        console.warn(`feed_facets refused, retrying once: ${error.message}`);
        await wait(FACET_RETRY_PAUSE_MS);
        return facetsFromDb(f, { ...opts, attempt: 1 });
      }
      console.error('feed_facets failed:', error.message);
      return null;
    }
    return (data as Facets) ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt === 0 && isTransientWriteError(message)) {
      console.warn(`feed_facets unavailable, retrying once: ${message}`);
      await wait(FACET_RETRY_PAUSE_MS);
      return facetsFromDb(f, { ...opts, attempt: 1 });
    }
    console.error('feed_facets unavailable:', err);
    return null;
  }
}
