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

async function main(): Promise<void> {
  const started = Date.now();
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
