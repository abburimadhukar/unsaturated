/**
 * Crawls every board and bakes the result into data/feed-snapshot.json.
 *
 * Runs as part of the production build. If the crawl fails, the build continues
 * with whatever snapshot already exists rather than shipping an empty site.
 */
import { existsSync } from 'node:fs';
import { refreshFeed } from '../corpus/live.js';
import { snapshotPath, writeSnapshot } from '../corpus/snapshot.js';

async function main(): Promise<void> {
  const started = Date.now();
  console.log('Crawling all boards for the build snapshot…');

  const feed = await refreshFeed();

  // Only cloud roles are ever rendered, and a full-corpus snapshot is ~7.6MB —
  // far too heavy to parse on every serverless cold start. Trimming keeps the
  // payload small while `scanned` preserves the true crawl size.
  const path = await writeSnapshot({
    ...feed,
    jobs: feed.jobs.filter((j) => j.inScope),
    scanned: feed.jobs.length,
  });

  const ok = feed.boards.filter((b) => !b.error).length;
  const cloud = feed.jobs.filter((j) => j.inScope).length;
  console.log(
    `Snapshot written in ${((Date.now() - started) / 1000).toFixed(0)}s\n` +
      `  ${feed.jobs.length} jobs · ${cloud} cloud roles · ${ok}/${feed.boards.length} boards ok\n` +
      `  → ${path}`,
  );
}

main().catch((err) => {
  console.error('Snapshot crawl failed:', err instanceof Error ? err.message : err);
  if (existsSync(snapshotPath())) {
    console.error('Continuing the build with the existing snapshot.');
    process.exitCode = 0;
  } else {
    process.exitCode = 1;
  }
});
