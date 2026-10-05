/**
 * Harvests ATS boards from Hacker News "Who is hiring?" threads.
 *
 *   npm run harvest:hn                   # last 24 threads -> discovered-boards.json
 *   npm run harvest:hn -- --months 6
 *   npm run harvest:hn -- --dry-run      # report without writing
 *   npm run harvest:hn -- --store db     # verify against the live APIs, store in Supabase
 *
 * Two destinations. The default MERGES into discovered-boards.json; existing
 * entries are never overwritten, so a re-run only ever adds. `--store db` instead
 * runs the same verify-and-store path the Common Crawl harvest uses and writes to
 * the `boards` registry with source 'hn' — which is what wires HN into the weekly
 * discovery. The file path once was the registry; it is now only an offline
 * fallback, so a harvest that writes only to it never reaches the crawl.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { harvestHiringThreads } from '../discovery/hn.js';
import { importBoards } from '../discovery/import.js';
import { verifyAndStore } from '../discovery/store-verified.js';
import { config } from '../config.js';
import type { BoardRef } from '../ats/types.js';
import type { OpenBoard } from '../discovery/opendata.js';

interface StoredBoard {
  provider: string;
  token: string;
  company: string;
  extra?: Record<string, string>;
}

const OUT = 'discovered-boards.json';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** "duck-duck-go" -> "Duck Duck Go". A placeholder until verification names it. */
function prettifyToken(token: string): string {
  return token
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * The DB path: harvest exact tokens from the threads, then verify and store them
 * in the registry exactly as the Common Crawl harvest does. verifyAndStore does
 * its own "already registered" filtering against the live table, so there is no
 * file to read or merge here.
 */
async function storeToDb(months: number, dryRun: boolean, verifyCap: number, delayMs: number): Promise<void> {
  console.log(`Scanning up to ${months} monthly HN hiring threads…`);
  const harvested = await harvestHiringThreads(months, (thread, found, total) => {
    console.log(`  ${thread.padEnd(42).slice(0, 42)} +${String(found).padStart(3)}  (${total} unique)`);
  });
  console.log(`\n${harvested.length} unique boards linked in those threads\n`);

  const candidates: OpenBoard[] = harvested.map((h) => ({
    provider: h.board.provider,
    token: h.board.token,
    company: prettifyToken(h.board.token),
    ...(h.board.extra ? { extra: h.board.extra } : {}),
  }));

  await verifyAndStore({
    candidates,
    source: 'hn',
    verifyCap,
    delayMs,
    dryRun,
    userAgent: config.userAgent,
  });
}

async function main(): Promise<void> {
  const months = Number.parseInt(arg('months') ?? '24', 10);
  const dryRun = process.argv.includes('--dry-run');

  if (arg('store') === 'db') {
    const verifyCap = Number.parseInt(arg('verify') ?? '3000', 10);
    const delayMs = Number.parseInt(arg('delay') ?? '1000', 10);
    await storeToDb(months, dryRun, verifyCap, delayMs);
    return;
  }

  const existing = new Map<string, StoredBoard>();
  if (existsSync(OUT)) {
    try {
      for (const b of JSON.parse(await readFile(OUT, 'utf8')) as StoredBoard[]) {
        existing.set(`${b.provider}:${b.token}`, b);
      }
    } catch {
      // Corrupt file — start clean rather than abort.
    }
  }
  console.log(`${existing.size} boards already known\n`);

  console.log(`Scanning up to ${months} monthly HN hiring threads…`);
  const harvested = await harvestHiringThreads(months, (thread, found, total) => {
    console.log(`  ${thread.padEnd(42).slice(0, 42)} +${String(found).padStart(3)}  (${total} unique)`);
  });
  console.log(`\n${harvested.length} unique boards linked in those threads`);

  // Only validate what we do not already have — re-checking known boards would
  // be pure waste against the providers.
  const fresh: BoardRef[] = harvested
    .map((h) => h.board)
    .filter((b) => !existing.has(`${b.provider}:${b.token}`));
  console.log(`${fresh.length} of them are new\n`);

  if (fresh.length === 0) {
    console.log('Nothing new to validate.');
    return;
  }

  console.log('Validating (one request each)…');
  const stats = await importBoards(fresh, 6, (done, total, valid) => {
    if (done % 10 === 0 || done === total) {
      process.stdout.write(`  ${done}/${total} checked · ${valid} live\r`);
    }
  });

  console.log(`\n\nlive: ${stats.valid.length}   no postings: ${stats.empty.length}   unreachable: ${stats.failed.length}`);

  const byProvider = new Map<string, number>();
  for (const v of stats.valid) byProvider.set(v.provider, (byProvider.get(v.provider) ?? 0) + 1);
  for (const [p, n] of [...byProvider.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(18)} ${n}`);
  }

  console.log('\nsample:');
  for (const v of stats.valid.slice(0, 12)) {
    console.log(`  ${v.company.padEnd(26).slice(0, 26)} ${v.provider}:${v.token}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const before = existing.size;
  for (const v of stats.valid) {
    const entry: StoredBoard = { provider: v.provider, token: v.token, company: v.company };
    if (v.extra) entry.extra = v.extra;
    existing.set(`${v.provider}:${v.token}`, entry);
  }

  await writeFile(OUT, JSON.stringify([...existing.values()], null, 2), 'utf8');
  console.log(`\n${existing.size} boards in ${OUT} (${before} before, +${existing.size - before} new)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
