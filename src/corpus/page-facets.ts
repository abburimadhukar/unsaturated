import { db } from '../db/supabase.js';
import { isTransientWriteError } from './db-feed.js';

/**
 * The tab and dropdown counts for Quiet Roles and Institutions, from one query.
 *
 * Both pages used to count each option with its own request — seventeen at once
 * per page view — which crowded the main feed off the free database. The
 * counting now happens in `quiet_facets` / `institution_facets`
 * (2026-09-25-page-facets.sql), one pass over the matching rows.
 */
export interface PageFacets {
  counts: Record<string, number>;
  countries: Record<string, number>;
  countryUnknown: number;
  /** Institutions only. */
  specializations?: Record<string, number>;
}

type Rpc = (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface PageFacetOptions {
  /** Injected so the retry can be tested without a database. */
  rpc?: Rpc;
  wait?: (ms: number) => Promise<void>;
}

const RETRY_PAUSE_MS = 150;

/**
 * null when the counts could not be had — never zeros.
 *
 * The caller leaves a missing count off the page. Reporting 0 would be an
 * invented number, and it is what the old per-option counts did whenever one
 * of them timed out.
 *
 * One retry, and only for a refusal (timeout, gateway), the same rule as the
 * main feed's facetsFromDb.
 */
export async function pageFacets(
  fn: 'quiet_facets' | 'institution_facets',
  params: Record<string, unknown>,
  opts: PageFacetOptions = {},
): Promise<PageFacets | null> {
  const rpc: Rpc = opts.rpc ?? ((name, p) => db().rpc(name, p));
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; attempt < 2; attempt++) {
    let message: string;
    try {
      const { data, error } = await rpc(fn, params);
      if (!error) {
        const body = data as PageFacets | null;
        if (body && typeof body.counts === 'object' && typeof body.countries === 'object') return body;
        console.error(`${fn} returned an unexpected shape`);
        return null;
      }
      message = error.message;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    if (attempt === 0 && isTransientWriteError(message)) {
      console.warn(`${fn} refused, retrying once: ${message}`);
      await wait(RETRY_PAUSE_MS);
      continue;
    }
    console.error(`${fn} failed:`, message);
    return null;
  }
  return null;
}
