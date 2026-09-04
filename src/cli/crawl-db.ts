/**
 * Crawls every board and writes the result to Supabase.
 *
 * This is what GitHub Actions runs. Unlike the snapshot build it does not
 * redeploy anything — the site reads the database directly, so fresh data needs
 * no rebuild. That is what makes hourly crawls affordable: ~70s per run against
 * ~4 minutes for a crawl-and-deploy.
 */
import { refreshFeed } from '../corpus/live.js';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
import { writeFeed } from '../corpus/db-feed.js';
import { recordCrawlOutcomes } from '../corpus/board-store.js';
import { tallyExclusions, recordExclusions } from '../corpus/exclusions.js';
import { config } from '../config.js';
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

  // --shard N --of M crawls one slice, so several jobs can run in parallel.
  // Each writes only the boards it crawled, and close-detection is already
  // scoped to boards that returned data this run, so a shard cannot close
  // another shard's postings.
  const shardIdx = Number.parseInt(argOf('shard') ?? '', 10);
  const shardOf = Number.parseInt(argOf('of') ?? '', 10);
  const shard =
    Number.isFinite(shardIdx) && Number.isFinite(shardOf) && shardOf > 1
      ? { index: shardIdx, of: shardOf }
      : undefined;
  if (shard) console.log(`shard ${shard.index + 1} of ${shard.of}`);

  const feed = await refreshFeed(shard);
  const ok = feed.boards.filter((b) => !b.error).length;
  const roles = feed.jobs.filter((j) => j.inScope).length;
  console.log(
    `crawled ${ok}/${feed.boards.length} boards · ${feed.jobs.length} jobs · ${roles} in-scope roles`,
  );

  // Count what is about to be discarded, before discarding it.
  //
  // Must happen here, on the full scanned set: writeFeed is handed only the
  // in-scope rows, so by the next statement the other ~93% no longer exist
  // anywhere. Counted in memory and written as a few thousand totals rather
  // than a quarter of a million rows.
  const tally = tallyExclusions(feed.jobs);

  // Only classified roles are stored. The rest are scanned to produce the
  // "N scanned" figure but never rendered, so persisting them would be waste.
  const { upserted, closed } = await writeFeed({
    ...feed,
    jobs: feed.jobs.filter((j) => j.inScope),
    scanned: feed.jobs.length,
  });

  // Both of these are bookkeeping, and neither may fail a crawl that has
  // already stored its jobs correctly.
  const dropped = feed.jobs.length - roles;
  const tallied = await recordExclusions(tally);

  // What the crawl learned about the boards themselves. Until this call existed,
  // last_crawled_at was NULL on all 12,479 boards and no board could ever retire
  // from crawl failures, however many times it failed.
  let boardNote = '';
  try {
    const { recorded, deactivated } = await recordCrawlOutcomes(
      feed.boards
        .filter((b) => b.token)
        .map((b) => ({
          provider: b.provider,
          token: b.token as string,
          ok: !b.error,
          jobs: b.jobs,
          ...(b.error ? { error: b.error } : {}),
        })),
      config.maxConsecutiveFailures,
    );
    boardNote = ` · ${recorded} boards recorded${deactivated ? `, ${deactivated} retired` : ''}`;
  } catch (err) {
    console.error('board outcomes not recorded:', err instanceof Error ? err.message : err);
  }

  console.log(
    `wrote ${upserted} roles, closed ${closed}${boardNote}
` +
      `discarded ${dropped} postings across ${tally.length} distinct titles` +
      `${tallied ? ` (${tallied} recorded)` : ''} · ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

main().catch((err) => {
  console.error('crawl failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
