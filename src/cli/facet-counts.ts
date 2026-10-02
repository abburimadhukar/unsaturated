/**
 * Recomputes the stored filter counts, after the whole crawl has finished.
 *
 *   npm run snapshot:facets
 *
 * WHY THIS IS ITS OWN COMMAND
 *
 * This used to run inside crawl-db.ts, guarded by `shard.index === 0`, the
 * moment that one shard finished. The other three keep crawling and writing for
 * several minutes afterwards — so the most expensive read in the database was
 * being asked for while three jobs were still hammering it, on a database whose
 * cache the crawl had just flushed. A cold feed_facets measures ~13 s against
 * the write client's 8-second budget. It did not fit.
 *
 * So it failed, quietly. Measured against production on 2 Oct 2026, the first
 * attempt failed on EVERY recent crawl and the 13:10 run failed all three:
 *
 *   13:35:30  facet snapshot attempt 1 of 3 did not come back
 *   13:36:08  facet snapshot attempt 2 of 3 did not come back
 *   13:36:48  facet snapshot attempt 3 of 3 did not come back
 *   13:36:48  facet snapshot not refreshed: the counts did not come back
 *
 * The counts had then not been rewritten for seven and a half hours. Nobody
 * noticed because until isDefaultShapeQuery landed nothing actually read them —
 * every real request carried hideGhosts=1 and matched no stored shape, so the
 * site counted live and the stale snapshot cost nothing visible.
 *
 * As its own job with `needs: crawl` this runs after EVERY shard has finished,
 * against a database that has gone quiet. It is the same pattern the warm job
 * has always used, and warming is now ordered after it so the views it heats
 * are ones whose counts already exist.
 *
 * EXIT CODE
 *
 * Non-zero when the counts did not come back. That is deliberate and it is the
 * point: this failing silently for seven hours is the bug being fixed, and the
 * site now depends on these numbers rather than merely preferring them. A red
 * square is the signal. It cannot fail the crawl itself — the jobs are already
 * stored by the time this runs, in a separate job — and the site still falls
 * back to counting live, so a failure here is visible without being an outage.
 */
import { refreshFacetSnapshot } from '../corpus/facet-snapshot.js';
import { canWrite, db } from '../db/supabase.js';

/**
 * Has anything changed since the last count?
 *
 * THIS GUARD IS NOT OPTIONAL. crawl.yml fires six times an hour, because
 * GitHub drops most scheduled runs — and `crawl:db` exits in seconds on five of
 * those six, refusing to re-crawl within 45 minutes. The crawl job therefore
 * succeeds six times an hour, and a `needs: crawl` job with no guard of its own
 * would run this whole 20-query pass every single time. That is six times an
 * hour against the ~5 a day it actually needs: far MORE load than the bug this
 * command was written to fix.
 *
 * So the condition is the honest one — recount only when a crawl has finished
 * since the counts were last written. Exact rather than a timer: shards finish
 * at different moments and `max(finished_at)` is the whole crawl's end.
 *
 * Fails OPEN. If either read fails we cannot tell, and counting when we did not
 * need to is a wasted job, while skipping when we did need to leaves the site
 * on stale numbers.
 */
async function crawlSinceLastCount(): Promise<boolean> {
  if (process.argv.includes('--force')) return true;
  try {
    const client = db();
    const [{ data: runs }, { data: snap }] = await Promise.all([
      client.from('crawl_runs').select('finished_at')
        .not('finished_at', 'is', null)
        .order('finished_at', { ascending: false }).limit(1),
      client.from('facet_snapshot').select('computed_at').eq('id', true).limit(1),
    ]);
    const crawled = Date.parse((runs?.[0]?.finished_at as string) ?? '');
    const counted = Date.parse((snap?.[0]?.computed_at as string) ?? '');
    // No snapshot yet, or no crawl recorded: count, do not skip.
    if (!Number.isFinite(crawled) || !Number.isFinite(counted)) return true;
    if (crawled <= counted) {
      console.log(
        `No crawl since the counts were written (crawl ${new Date(crawled).toISOString()}, ` +
          `counts ${new Date(counted).toISOString()}); skipping.`,
      );
      return false;
    }
  } catch {
    // Cannot tell — count rather than skip.
  }
  return true;
}

async function main(): Promise<void> {
  // The counts are written through the service key, which gets 8 seconds rather
  // than anon's 3. Without it dbWrite falls back to the publishable key, which
  // RLS will refuse — so say so plainly instead of reporting a green run that
  // stored nothing.
  if (!canWrite()) {
    console.error(
      'No SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY is set — the counts cannot be written.',
    );
    process.exitCode = 1;
    return;
  }

  if (!(await crawlSinceLastCount())) return;

  const started = Date.now();
  const stored = await refreshFacetSnapshot();
  const secs = ((Date.now() - started) / 1000).toFixed(0);

  if (!stored) {
    console.error(`filter counts NOT stored · ${secs}s`);
    process.exitCode = 1;
    return;
  }
  console.log(`filter counts stored · ${secs}s`);
}

main().catch((err) => {
  console.error('filter counts failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
