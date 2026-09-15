/**
 * Harvests new board tokens from the Internet Archive, verifies them, stores them.
 *
 *   npm run harvest:ia -- --provider greenhouse   one vendor only
 *   npm run harvest:ia -- --dry-run               report only
 *   npm run harvest:ia -- --from 20260101         captures since this day
 *   npm run harvest:ia -- --verify 400            verify at most N of the new ones
 *
 * The twin of harvest:cc, and it exists because one index is not enough. Common
 * Crawl publishes monthly and had published nothing for five weeks when this was
 * written, so the weekly discovery run had nothing new to read. The Archive is
 * written to continuously.
 *
 * Everything after the harvest is identical — same patterns, same extraction,
 * same verifier, same store — so a board found here is indistinguishable from
 * one found there except for `source`, which is the point: the registry does not
 * care where a token came from, only that it answered.
 */
import { config } from '../config.js';
import { harvestWayback } from '../discovery/wayback.js';
import { summariseVerification, verifyBoards } from '../discovery/verify.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** Identical to harvest:cc — see the long note there on case and on the site. */
const keyOf = (b: { provider: string; token: string; extra?: Record<string, string> }) =>
  `${b.provider}:${b.token.toLowerCase()}:${(b.extra?.site ?? '').toLowerCase()}`;

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const only = arg('provider');
  const from = arg('from');
  const verifyCap = Number.parseInt(arg('verify') ?? '400', 10);
  const delayMs = Number.parseInt(arg('delay') ?? '1000', 10);

  console.log('Reading the Internet Archive URL index…\n');
  const { boards, reports } = await harvestWayback({
    userAgent: config.userAgent,
    ...(only ? { provider: only as never } : {}),
    ...(from ? { from } : {}),
    onProgress: (m) => console.log(m),
  });

  if (only && reports.length === 0) {
    console.log(`${only} has no harvest pattern. Nothing to read, and that is expected.`);
    return;
  }

  // An outage is not a verdict. The Archive answers HTTP 200 with an apology
  // page when it is down, so a run that could not read must not look like a run
  // that found nothing — otherwise "greenhouse: 0 new" reads as saturation.
  const failed = reports.filter((r) => r.error);
  if (failed.length > 0) {
    console.log('\n  WARNING: the Archive did not answer for some patterns:');
    for (const r of failed) console.log(`    ${r.pattern}: ${r.error}`);
    console.log('  Nothing found here is evidence about those vendors.');
  }

  // Zero rows for a host is almost always robots.txt rather than an empty
  // archive — it is why Lever and Workday are unreachable from here. Said out
  // loud so nobody spends an afternoon on it twice.
  const empty = reports.filter((r) => r.empty);
  if (empty.length > 0) {
    console.log(
      `\n  ${empty.length} pattern(s) hold no captures: ${empty.map((r) => r.pattern).join(', ')}`,
    );
    console.log('  Archival crawlers are excluded by those hosts. Expected, not a fault.');
  }

  const urls = reports.reduce((n, r) => n + r.urls, 0);
  console.log(`\n${urls.toLocaleString()} archived urls -> ${boards.length} distinct boards`);

  const { readActiveBoards } = await import('../corpus/board-store.js');
  const registered = await readActiveBoards();
  if (registered === null) {
    console.error('Could not read the board registry. Refusing to harvest against an unknown registry.');
    process.exitCode = 1;
    return;
  }
  const known = new Set(registered.map(keyOf));
  const fresh = boards
    .filter((b) => !known.has(keyOf(b)))
    .filter((b) => !only || b.provider === only);
  console.log(`${known.size} already registered · ${fresh.length} not seen before\n`);

  if (fresh.length === 0) {
    console.log('Nothing new in the Archive.');
    return;
  }

  const batch = fresh.slice(0, Math.max(0, verifyCap));
  console.log(
    `Verifying ${batch.length} of them at ${delayMs}ms apart (~${Math.round((batch.length * delayMs) / 60_000)} min).\n`,
  );

  const results = await verifyBoards(batch, {
    userAgent: config.userAgent,
    delayMs,
    onResult: (_r, done, total) => {
      if (done % 25 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`);
    },
  });

  const live = results.filter((r) => r.verdict === 'live');
  console.log('\n' + summariseVerification(results));
  console.log(`  jobs behind them: ${live.reduce((n, r) => n + r.jobs, 0).toLocaleString()}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const { upsertBoards } = await import('../corpus/board-store.js');
  const stored = await upsertBoards(
    live.map((r) => ({
      provider: r.board.provider,
      token: r.board.token,
      company: r.company ?? r.board.company,
      extra: r.extra ?? r.board.extra ?? {},
      // Distinct from 'commoncrawl' on purpose: which index found a board is
      // the only way to tell afterwards whether adding the second one paid.
      source: 'wayback',
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
