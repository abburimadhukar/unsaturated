import { dbWrite } from '../db/supabase.js';
import { facetsFromDb } from './db-query.js';

/**
 * Stores the unfiltered filter counts so a page view does not have to compute
 * them.
 *
 * `feed_facets` was 16% of all database time — 26,377 calls, 273ms mean,
 * 2,992ms worst — which is twice what fetching the actual jobs costs. It is
 * expensive honestly: feed_page finds 50 rows and stops, while the counts sweep
 * all ~39,700 matching rows eight times over, once per filter dimension.
 *
 * What made it waste rather than cost is that the answer only changes when a
 * crawl finishes. Between crawls it was recomputed on every page view and
 * returned the same numbers every time.
 *
 * And it was not only slow. facetsFromDb returns null on a refusal and the feed
 * route substitutes EMPTY facets for a null, so a timed-out count rendered the
 * site with every filter at zero and the total reading 0 — jobs listed right
 * beside them. Not an error page: a site that looks empty. A stored number
 * cannot time out, which removes that failure instead of narrowing it.
 *
 * Written by ONE shard, like the purge, and never fatal: a crawl that stored
 * its jobs correctly must not fail because a cache did not refresh.
 */
export async function refreshFacetSnapshot(): Promise<boolean> {
  try {
    // Computed through the same function the site calls, with the same default
    // query, rather than a second copy of the counting logic here. A snapshot
    // that disagreed with the live path would be worse than no snapshot.
    const facets = await facetsFromDb({}, { snapshot: false });
    if (!facets) {
      console.warn('facet snapshot not refreshed: the counts did not come back');
      return false;
    }

    const { error } = await dbWrite()
      .from('facet_snapshot')
      .upsert(
        { id: true, facets, computed_at: new Date().toISOString() },
        { onConflict: 'id' },
      );
    if (error) {
      console.warn(`facet snapshot not refreshed: ${error.message}`);
      return false;
    }
    console.log('facet snapshot refreshed');
    return true;
  } catch (err) {
    console.warn(
      'facet snapshot not refreshed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
