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

/**
 * A filtered page WITHOUT its count — the fallback when feed_page's count times
 * out.
 *
 * feed_page returns the rows AND counts the whole match for the total; on the
 * free tier that count is the ~3s query that 503s for a heavy filter combination
 * (measured 1 Oct 2026: ?family=cloud&country=US). feed_rows is feed_page with the
 * count removed, so it returns the same rows cheaply. The caller takes the total
 * from the facets, which it already has. Same parameters as feed_page.
 *
 * ONE RETRY, AND ONLY FOR A REFUSAL — the same rule as feed_page.
 */
export async function queryRowsFromDb(
  f: FeedQuery,
  offset: number,
  limit: number,
  opts: FacetOptions = {},
): Promise<FeedJob[] | null> {
  const attempt = opts.attempt ?? 0;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const client = opts.client ?? db();
  let message: string;
  try {
    const { data, error } = await client.rpc('feed_rows', {
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
      p_keep_unknown: f.includeUnknown !== false,
      p_sort: f.sort ?? 'newest',
      p_offset: offset,
      p_limit: limit,
      p_stack: orNull(f.stack),
      p_specialization: orNull(f.specialization),
      p_adjacent: orNull(f.adjacent),
    });
    if (!error) {
      const rows = (data as { rows?: JobRow[] } | null)?.rows;
      if (!Array.isArray(rows)) return null;
      return rows.map((r) => toFeedJob(r));
    }
    message = error.message;
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (attempt === 0 && isTransientWriteError(message)) {
    console.warn(`feed_rows refused, retrying once: ${message}`);
    await wait(FACET_RETRY_PAUSE_MS);
    return queryRowsFromDb(f, offset, limit, { ...opts, attempt: 1 });
  }
  console.error('feed_rows failed:', message);
  return null;
}

/**
 * The default view — no filters, newest first — without counting it.
 *
 * feed_page counts every match (~40,000 rows) to report the total, and for
 * this view that count was nearly all of its cost: 2.6 s against anon's 3 s
 * limit, measured 25 Sep 2026, while the 50 rows themselves take ~40 ms once
 * the ORDER BY can use the date index. See 2026-09-25-feed-newest.sql.
 *
 * So this returns the rows only. The caller takes the total from the sidebar
 * counts, which for this view already hold it (facets.adjacent.core — equal to
 * feed_page's total, checked at the same instant). One row more than asked is
 * fetched so `hasMore` is exact rather than inferred from that total.
 *
 * Null on any failure; the caller falls back to feed_page.
 */
export async function queryNewestFromDb(
  offset: number,
  limit: number,
  opts: FacetOptions = {},
  /**
   * Restrict to one family, or null for the unfiltered default view.
   *
   * Added so the family tabs can take the same road as the default view: rows
   * only, no count, with the total coming from the per-family snapshot. feed_page
   * counts the family's whole match for its total, which is the ~3 s query that
   * 503s on the free tier for the largest family. A rows-only fetch does not.
   * The p_family overload of feed_newest is additive — the 3-arg version still
   * exists — so an old deployment calling it without a family keeps working.
   */
  family: string | null = null,
): Promise<{ jobs: FeedJob[]; hasMore: boolean } | null> {
  const attempt = opts.attempt ?? 0;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const client = opts.client ?? db();
  let message: string;
  try {
    const { data, error } = await client.rpc('feed_newest', {
      p_cutoff: cutoffIso(),
      p_offset: offset,
      p_limit: limit + 1,
      p_family: family,
    });
    if (!error) {
      const rows = (data as { rows?: JobRow[] } | null)?.rows;
      if (!Array.isArray(rows)) return null;
      return { jobs: rows.slice(0, limit).map((r) => toFeedJob(r)), hasMore: rows.length > limit };
    }
    message = error.message;
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (attempt === 0 && isTransientWriteError(message)) {
    console.warn(`feed_newest refused, retrying once: ${message}`);
    await wait(FACET_RETRY_PAUSE_MS);
    return queryNewestFromDb(offset, limit, { ...opts, attempt: 1 }, family);
  }
  // Not fatal: the caller asks feed_page instead, which is slower but whole.
  console.error('feed_newest failed:', message);
  return null;
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
 * The real families, each a tab on the main feed. 'unsorted' is deliberately
 * excluded: it is a review queue, not a landing page, so it is never pre-counted
 * and keeps using the live path.
 *
 * Shared by the snapshot writer (which counts each one per crawl) and
 * isFamilyOnlyQuery (which decides when a request may read those counts), so the
 * two cannot drift apart.
 */
export const SNAPSHOT_FAMILIES = ['cloud', 'software', 'data', 'hris'] as const;

/**
 * True when the ONLY thing narrowed is the family, to one of the real four,
 * newest first — the family tabs every visitor clicks.
 *
 * This is isUnfilteredQuery with the family allowed. It is the second query shape
 * the per-crawl snapshot can answer: the counts are stored per family, and the
 * rows come from feed_newest filtered by family, so neither the live count nor
 * feed_page runs. Any further filter (a country, a search, a specialization)
 * falls back to the live path exactly as before — a stored per-family number
 * cannot stand in for a filtered one, the same reason the default snapshot is
 * default-only.
 */
export function isFamilyOnlyQuery(f: FeedQuery): boolean {
  return (
    !!f.family && (SNAPSHOT_FAMILIES as readonly string[]).includes(f.family) &&
    !f.country && !f.remote && !f.seniority && !f.employmentType &&
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

  // The stored answer, for the two query shapes that can use it.
  //
  // Read first on the default view and on a family-only view. A miss costs one
  // primary-key lookup on a single-row table and falls through to the live count,
  // so the worst case is what this path already did. The default view reads
  // `facets`; a family tab reads its entry in `by_family`, written per crawl.
  if (
    attempt === 0 && opts.snapshot !== false && !opts.client &&
    (isUnfilteredQuery(f) || isFamilyOnlyQuery(f))
  ) {
    try {
      const { data, error } = await db()
        .from('facet_snapshot')
        .select('facets,by_family,computed_at')
        .eq('id', true)
        .maybeSingle();
      const row = data as
        | { facets: Facets; by_family: Record<string, Facets> | null; computed_at: string }
        | null;
      if (!error && row) {
        const age = Date.now() - Date.parse(row.computed_at);
        if (Number.isFinite(age) && age >= 0 && age < SNAPSHOT_MAX_AGE_MS) {
          if (isUnfilteredQuery(f) && row.facets) return row.facets;
          // A family tab: use its stored counts if the last crawl computed them;
          // otherwise fall through to the live count for this one family.
          const perFamily = f.family && row.by_family ? row.by_family[f.family] : undefined;
          if (perFamily) return perFamily;
        }
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
