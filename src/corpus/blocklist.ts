import { db } from '../db/supabase.js';

/**
 * Boards that must never be crawled, whatever discovery finds.
 *
 * The whole premise is reading employers' own job boards, so an aggregator that
 * republishes other companies' postings is the one thing that must not get in:
 * its apply links go to a middleman, and the same role arrives again under a
 * different name. Two of them were contributing 1,269 jobs — 8% of the feed —
 * from 2 boards out of 12,214.
 *
 * Enforced rather than tidied by hand, because discovery adds a couple of
 * hundred boards a week out of a web archive and aggregators are exactly what
 * turns up there. Deactivating one manually only holds until it is rediscovered.
 *
 * Checked in two places: discovery, so a blocked board is never stored, and the
 * crawl, so one already stored is never read.
 */

export interface BlockedBoard {
  provider: string;
  token: string;
  reason: string;
}

const CACHE_KEY = Symbol.for('unsaturated.blocklist');
/** Small and rarely changed, so a short cache saves a query per crawl shard. */
const CACHE_MS = 5 * 60_000;

interface Slot {
  keys: Set<string> | null;
  at: number;
}

function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  g[CACHE_KEY] ??= { keys: null, at: 0 };
  return g[CACHE_KEY]!;
}

export const blockKey = (provider: string, token: string) => `${provider}:${token}`;

/**
 * The blocked set, or an empty set if it cannot be read.
 *
 * Failing open is deliberate: an unreachable blocklist should let the crawl run
 * with a couple of unwanted boards, not stop it reading twelve thousand good
 * ones.
 */
export async function loadBlocklist(): Promise<Set<string>> {
  const s = slot();
  if (s.keys && Date.now() - s.at < CACHE_MS) return s.keys;

  try {
    const { data, error } = await db().from('blocked_boards').select('provider,token');
    if (error) {
      console.error('blocklist unavailable:', error.message);
      return s.keys ?? new Set();
    }
    const keys = new Set(
      (data as { provider: string; token: string }[]).map((b) => blockKey(b.provider, b.token)),
    );
    s.keys = keys;
    s.at = Date.now();
    return keys;
  } catch (err) {
    console.error('blocklist unavailable:', err);
    return s.keys ?? new Set();
  }
}
