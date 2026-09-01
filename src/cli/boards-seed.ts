/**
 * Seeds the board registry from published open datasets.
 *
 *   npm run boards:seed -- --dry-run          report what would be added
 *   npm run boards:seed -- --sample 200       verify a sample, then report
 *   npm run boards:seed -- --out boards.json  write to a file instead of the DB
 *   npm run boards:seed                       write to Supabase
 *
 * Nothing is written until it has been verified live, because the source is a
 * historical crawl harvest where a large share of tokens are dead.
 */
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { fetchOpenBoards, type OpenBoard } from '../discovery/opendata.js';
import { verifyBoards } from '../discovery/verify.js';
import { loadBoardsAsync } from '../corpus/boards.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

function keyOf(b: OpenBoard | { provider: string; token: string; extra?: Record<string, string> }): string {
  return b.provider === 'workday'
    ? `workday:${b.token}:${b.extra?.site ?? ''}`
    : `${b.provider}:${b.token}`;
}

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const out = arg('out');
  const sampleRaw = arg('sample');
  const sample = sampleRaw ? Number.parseInt(sampleRaw, 10) : 0;
  const delayMs = Number.parseInt(arg('delay') ?? '1000', 10);

  console.log('Downloading open board datasets…');
  const { boards, reports } = await fetchOpenBoards(config.userAgent);
  for (const r of reports) {
    console.log(`  ${r.provider.padEnd(12)} ${String(r.raw).padStart(6)} entries -> ${r.usable} usable`);
  }
  console.log(`  ${boards.length} distinct boards after dedupe\n`);

  // Anything already crawling is known good; re-verifying it wastes an hour of
  // rate-limited requests and risks demoting a live board on a transport blip.
  const known = new Set((await loadBoardsAsync()).map(keyOf));
  const fresh = boards.filter((b) => !known.has(keyOf(b)));
  console.log(`${known.size} already in the registry · ${fresh.length} new\n`);

  if (fresh.length === 0) {
    console.log('Nothing new to add.');
    return;
  }

  let candidates = fresh;
  if (sample > 0) {
    const pool = [...fresh];
    candidates = [];
    while (candidates.length < sample && pool.length > 0) {
      candidates.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
    }
    console.log(`Sampling ${candidates.length} of ${fresh.length}.\n`);
  }

  const estMin = Math.round((candidates.length * delayMs) / 60_000);
  console.log(
    `Verifying ${candidates.length} boards at ${delayMs}ms apart (~${estMin} min).\n` +
      'Slow on purpose: Greenhouse drops bursts from datacenter IPs, and a\n' +
      'dropped connection is not a dead board.\n',
  );

  const results = await verifyBoards(candidates, {
    userAgent: config.userAgent,
    delayMs,
    onResult: (_r, done, total) => {
      if (done % 25 === 0 || done === total) {
        process.stdout.write(`  ${done}/${total} checked\r`);
      }
    },
  });

  const live = results.filter((r) => r.verdict === 'live');
  const dead = results.filter((r) => r.verdict === 'dead');
  const unknown = results.filter((r) => r.verdict === 'unknown');
  const jobs = live.reduce((n, r) => n + r.jobs, 0);
  const domains = live.filter((r) => r.domain).length;

  console.log('\n');
  console.log(`  live     ${String(live.length).padStart(6)}  (${Math.round((100 * live.length) / results.length)}%)`);
  console.log(`  dead     ${String(dead.length).padStart(6)}`);
  console.log(`  unclear  ${String(unknown.length).padStart(6)}  (rate-limited — retry, do not discard)`);
  console.log(`  jobs behind the live boards: ${jobs.toLocaleString()}`);
  console.log(`  corporate domains recovered: ${domains}`);

  const byProvider = new Map<string, number>();
  for (const r of live) byProvider.set(r.board.provider, (byProvider.get(r.board.provider) ?? 0) + 1);
  console.log('\n  live by provider:');
  for (const [p, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${p.padEnd(14)} ${n}`);
  }

  if (sample > 0) {
    const rate = live.length / results.length;
    console.log(`\n  Projected across all ${fresh.length} new boards: ~${Math.round(fresh.length * rate).toLocaleString()} live`);
  }

  const additions = live.map((r) => ({
    provider: r.board.provider,
    token: r.board.token,
    company: r.board.company,
    ...(r.board.extra ? { extra: r.board.extra } : {}),
  }));

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  if (out) {
    await writeFile(out, JSON.stringify(additions, null, 2), 'utf8');
    console.log(`\nWrote ${additions.length} verified boards to ${out}`);
    return;
  }

  const { upsertBoards } = await import('../corpus/board-store.js');
  const n = await upsertBoards(
    live.map((r) => ({
      provider: r.board.provider,
      token: r.board.token,
      company: r.board.company,
      extra: r.board.extra ?? {},
      source: 'opendata',
      jobCount: r.jobs,
      ...(r.domain ? { domain: r.domain } : {}),
    })),
  );
  console.log(`\nStored ${n} verified boards in Supabase.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
