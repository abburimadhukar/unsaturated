/**
 * Harvests new board tokens from Common Crawl, verifies them, and stores them.
 *
 *   npm run harvest:cc -- --provider workday  one vendor only
 *   npm run harvest:cc -- --dry-run           report only
 *   npm run harvest:cc -- --crawl CC-MAIN-…   a specific crawl
 *   npm run harvest:cc -- --verify 400        verify at most N of the new ones
 *   npm run harvest:cc                        harvest, verify, store
 *
 * This is the step that stops the board list being hand-maintained. A new crawl
 * lands about monthly; running this on a schedule keeps the registry current
 * with no one guessing company slugs.
 */
import { config } from '../config.js';
import { harvestCommonCrawl } from '../discovery/commoncrawl.js';
import { verifyBoards } from '../discovery/verify.js';
import { loadBoardsAsync } from '../corpus/boards.js';
import type { OpenBoard } from '../discovery/opendata.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const keyOf = (b: { provider: string; token: string; extra?: Record<string, string> }) =>
  b.provider === 'workday' ? `workday:${b.token}:${b.extra?.site ?? ''}` : `${b.provider}:${b.token}`;

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const crawl = arg('crawl');
  const verifyCap = Number.parseInt(arg('verify') ?? '400', 10);
  const delayMs = Number.parseInt(arg('delay') ?? '1000', 10);

  console.log('Reading the Common Crawl URL index…\n');
  const { crawl: used, boards, reports } = await harvestCommonCrawl({
    userAgent: config.userAgent,
    ...(crawl ? { crawl } : {}),
    onProgress: (m) => console.log(m),
  });

  const urls = reports.reduce((n, r) => n + r.urls, 0);
  console.log(`\n${used}: ${urls.toLocaleString()} indexed urls -> ${boards.length} distinct boards`);

  const known = new Set((await loadBoardsAsync()).map(keyOf));
  // Sliced by vendor rather than by count, so several runs in parallel still
  // give each ATS exactly one request per second. Splitting by count instead
  // would point every runner at every vendor at once, which is how Greenhouse
  // starts dropping connections and live boards get recorded as dead.
  const only = arg('provider');
  const fresh = boards
    .filter((b) => !known.has(keyOf(b)))
    .filter((b) => !only || b.provider === only);
  if (only) console.log(`provider filter: ${only}`);
  console.log(`${known.size} already registered · ${fresh.length} not seen before\n`);

  if (fresh.length === 0) {
    console.log('Nothing new in this crawl.');
    return;
  }

  // Verification is the slow part, so a run takes a bounded slice and the next
  // run picks up where this one stopped.
  const batch = fresh.slice(0, Math.max(0, verifyCap));
  console.log(`Verifying ${batch.length} of them at ${delayMs}ms apart (~${Math.round((batch.length * delayMs) / 60_000)} min).\n`);

  const results = await verifyBoards(batch, {
    userAgent: config.userAgent,
    delayMs,
    onResult: (_r, done, total) => {
      if (done % 25 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`);
    },
  });

  const live = results.filter((r) => r.verdict === 'live');
  const unclear = results.filter((r) => r.verdict === 'unknown');
  console.log(
    `\n\n  live ${live.length} · dead ${results.length - live.length - unclear.length} · unclear ${unclear.length}`,
  );
  console.log(`  jobs behind them: ${live.reduce((n, r) => n + r.jobs, 0).toLocaleString()}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const { upsertBoards } = await import('../corpus/board-store.js');
  const stored = await upsertBoards(
    live.map((r: { board: OpenBoard; jobs: number; domain?: string }) => ({
      provider: r.board.provider,
      token: r.board.token,
      company: r.board.company,
      extra: r.board.extra ?? {},
      source: 'commoncrawl',
      jobCount: r.jobs,
      ...(r.domain ? { domain: r.domain } : {}),
    })),
  );
  console.log(`\nStored ${stored} new boards. ${fresh.length - batch.length} still queued for a later run.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
