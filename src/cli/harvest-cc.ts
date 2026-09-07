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
import { summariseVerification, verifyBoards } from '../discovery/verify.js';
import { loadBoardsAsync } from '../corpus/boards.js';
import type { OpenBoard } from '../discovery/opendata.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

/**
 * The identity of a board, for deciding whether we already have it.
 *
 * LOWERCASED, because these APIs are. Verified 7 Sep 2026: ashby/accord and
 * ashby/Accord both return the same 4 jobs, greenhouse/babylist and
 * greenhouse/Babylist the same 46, smartrecruiters/bluescope and
 * smartrecruiters/BlueScope the same 37. The web archive holds both spellings
 * of the same company, so a case-sensitive key stored each as a new board.
 *
 * It already had: 317 case-variant pairs sit in the registry, and because a job
 * key is provider:token:id, both copies stored the same posting under different
 * keys — AbbVie appears twice with 41 jobs each, and a Staff Software Engineer
 * at Accord is listed twice on the site today.
 *
 * The stored token keeps its original case, because that is what the vendor
 * printed and it costs nothing to be faithful. Only the comparison folds.
 */
const keyOf = (b: { provider: string; token: string; extra?: Record<string, string> }) => {
  const token = b.token.toLowerCase();
  return b.provider === 'workday'
    ? `workday:${token}:${(b.extra?.site ?? '').toLowerCase()}`
    : `${b.provider}:${token}`;
};

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const crawl = arg('crawl');
  const verifyCap = Number.parseInt(arg('verify') ?? '400', 10);
  const delayMs = Number.parseInt(arg('delay') ?? '1000', 10);

  const only = arg('provider');

  console.log('Reading the Common Crawl URL index…\n');
  const { crawl: used, boards, reports } = await harvestCommonCrawl({
    userAgent: config.userAgent,
    ...(crawl ? { crawl } : {}),
    // Only this vendor's patterns. Every job in the discovery matrix used to
    // read the WHOLE index and then discard all but its own provider — eleven
    // times the load on Common Crawl's query server for one eleventh of the
    // value, which is what made it start refusing pages.
    ...(only ? { provider: only as never } : {}),
    onProgress: (m) => console.log(m),
  });

  if (only && reports.length === 0) {
    console.log(
      `${only} has no Common Crawl pattern — its tokens come from the open dataset, ` +
        'not the index. Nothing to harvest, and that is expected.',
    );
    return;
  }

  const urls = reports.reduce((n, r) => n + r.urls, 0);
  console.log(`\n${used}: ${urls.toLocaleString()} indexed urls -> ${boards.length} distinct boards`);

  // A refused page is a silent hole in the candidate list, and the silence is
  // exactly how this went unnoticed: runs reported success while each held a
  // different partial view of the index, so Greenhouse offered 701 candidates
  // one run and 44 the next, and boards the size of Airbnb never surfaced.
  const lost = reports.filter((r) => r.pagesRead < r.pagesTotal);
  if (lost.length > 0) {
    const missed = lost.reduce((n, r) => n + (r.pagesTotal - r.pagesRead), 0);
    console.log(
      `\n  WARNING: ${missed} index page(s) refused — this harvest saw only part of the index:`,
    );
    for (const r of lost) {
      console.log(`    ${r.pattern}: read ${r.pagesRead} of ${r.pagesTotal} pages`);
    }
    console.log('  A candidate missing from this run is not evidence that a board is gone.');
  }

  const known = new Set((await loadBoardsAsync()).map(keyOf));
  // Sliced by vendor rather than by count, so several runs in parallel still
  // give each ATS exactly one request per second. Splitting by count instead
  // would point every runner at every vendor at once, which is how Greenhouse
  // starts dropping connections and live boards get recorded as dead.
  //
  // The harvest above already read only this vendor's patterns; this second
  // filter is belt and braces for a run with no --provider at all.
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
  // The status codes, not just the verdicts — see summariseVerification. This
  // run reporting "dead 701" told us nothing about whether those boards were
  // gone or whether we were being turned away.
  console.log('\n' + summariseVerification(results));
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
