/**
 * Re-checks registered boards and retires ones that have genuinely gone.
 *
 *   npm run boards:verify -- --dry-run
 *   npm run boards:verify -- --limit 500
 *
 * Separate from the crawl on purpose: verification runs at roughly one request
 * per second because Greenhouse drops bursts from datacenter IPs, and a crawl
 * cannot afford to wait. A board is only retired after several consecutive
 * failures, since one failure is far more often a rate limit than a closure.
 */
import { config } from '../config.js';
import { loadBoardsAsync } from '../corpus/boards.js';
import { verifyBoards } from '../discovery/verify.js';
import type { OpenBoard } from '../discovery/opendata.js';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number.parseInt(arg('limit') ?? '500', 10);
  const delayMs = Number.parseInt(arg('delay') ?? '1000', 10);

  const all = await loadBoardsAsync();
  const batch = all.slice(0, limit).map(
    (b): OpenBoard => ({
      provider: b.provider,
      token: b.token,
      company: b.company,
      ...(b.extra ? { extra: b.extra } : {}),
    }),
  );

  console.log(`${all.length} registered · checking ${batch.length} at ${delayMs}ms apart\n`);

  const results = await verifyBoards(batch, {
    userAgent: config.userAgent,
    delayMs,
    onResult: (_r, done, total) => {
      if (done % 25 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`);
    },
  });

  const live = results.filter((r) => r.verdict === 'live');
  const dead = results.filter((r) => r.verdict === 'dead');
  const unclear = results.filter((r) => r.verdict === 'unknown');

  console.log(`\n\n  live ${live.length} · dead ${dead.length} · unclear ${unclear.length}`);
  if (dead.length > 0) {
    console.log('\n  no longer answering:');
    for (const d of dead.slice(0, 15)) {
      console.log(`    ${d.board.provider}:${d.board.token} (HTTP ${d.status})`);
    }
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const { recordCrawlOutcomes } = await import('../corpus/board-store.js');
  // `unclear` is deliberately excluded: it means we could not tell, and counting
  // it as a failure is how a rate limit turns into a deleted board.
  const { deactivated } = await recordCrawlOutcomes(
    [
      ...live.map((r) => ({ provider: r.board.provider, token: r.board.token, ok: true, jobs: r.jobs })),
      ...dead.map((r) => ({ provider: r.board.provider, token: r.board.token, ok: false, jobs: 0 })),
    ],
    config.maxConsecutiveFailures,
  );
  console.log(`\nRecorded. ${deactivated} board(s) retired after ${config.maxConsecutiveFailures} consecutive failures.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
