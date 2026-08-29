/**
 * Polls every active board once.
 *
 *   npm run crawl
 *   npm run crawl -- --limit 50
 */
import { closePool } from '../db/client.js';
import { runCrawl } from '../ingest/crawler.js';

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number.parseInt(process.argv[limitArg + 1] ?? '', 10) : undefined;

  const started = Date.now();
  const stats = await runCrawl(Number.isFinite(limit) ? { limit: limit! } : {});
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `crawled ${stats.boardsOk}/${stats.boardsTotal} boards in ${seconds}s ` +
      `(${stats.boardsFailed} failed)\n` +
      `  new: ${stats.jobsNew}  updated: ${stats.jobsUpdated}  ` +
      `closed: ${stats.jobsClosed}  reposts: ${stats.repostsFound}`,
  );

  for (const e of stats.errors.slice(0, 20)) {
    console.log(`  ! ${e.provider}/${e.token}: ${e.message}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
