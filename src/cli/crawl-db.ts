/**
 * Crawls every board and writes the result to Supabase.
 *
 * This is what GitHub Actions runs. Unlike the snapshot build it does not
 * redeploy anything — the site reads the database directly, so fresh data needs
 * no rebuild. That is what makes hourly crawls affordable: ~70s per run against
 * ~4 minutes for a crawl-and-deploy.
 */
import { refreshFeed } from '../corpus/live.js';
import { writeFeed } from '../corpus/db-feed.js';
import { db } from '../db/supabase.js';

/**
 * Skip if the corpus was refreshed very recently.
 *
 * GitHub drops most scheduled runs on a free private repo, so the schedule
 * carries several slots per hour to raise the odds one of them fires. This
 * guard is what makes that safe: duplicate triggers exit in seconds instead of
 * re-crawling a thousand boards and burning the minutes budget.
 */
const MIN_GAP_MINUTES = 45;

async function recentlyCrawled(): Promise<boolean> {
  if (process.argv.includes('--force')) return false;
  try {
    const { data } = await db()
      .from('crawl_runs')
      .select('finished_at')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1);
    const last = data?.[0]?.finished_at as string | undefined;
    if (!last) return false;
    const mins = (Date.now() - Date.parse(last)) / 60_000;
    if (mins < MIN_GAP_MINUTES) {
      console.log(`Last crawl was ${mins.toFixed(0)} min ago (< ${MIN_GAP_MINUTES}); skipping.`);
      return true;
    }
  } catch {
    // Cannot tell how stale it is — crawl rather than skip.
  }
  return false;
}

async function main(): Promise<void> {
  const started = Date.now();
  if (await recentlyCrawled()) return;
  console.log('Crawling all boards…');

  const feed = await refreshFeed();
  const ok = feed.boards.filter((b) => !b.error).length;
  const roles = feed.jobs.filter((j) => j.inScope).length;
  console.log(
    `crawled ${ok}/${feed.boards.length} boards · ${feed.jobs.length} jobs · ${roles} in-scope roles`,
  );

  // Only classified roles are stored. The rest are scanned to produce the
  // "N scanned" figure but never rendered, so persisting them would be waste.
  const { upserted, closed } = await writeFeed({
    ...feed,
    jobs: feed.jobs.filter((j) => j.inScope),
    scanned: feed.jobs.length,
  });

  console.log(
    `wrote ${upserted} roles, closed ${closed} · ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

main().catch((err) => {
  console.error('crawl failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
