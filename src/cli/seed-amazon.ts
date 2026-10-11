/**
 * Registers Amazon state boards in the `boards` registry.
 *
 *   npm run seed:amazon -- --dry-run        show what would be written
 *   npm run seed:amazon                      register Washington (the default)
 *   npm run seed:amazon -- --states wa,ca    register several states at once
 *
 * WHY THIS, AND NOT discover / detect / dataset:diff
 *
 * Amazon publishes its OWN listings API (see src/ats/adapters/amazon.ts) rather
 * than running a third-party ATS, so none of the generic discovery channels —
 * careers-page detection, the open datasets, the crawl indexes — can reach it.
 * It is the largest Washington employer and ran nowhere in the corpus. The board
 * is registered by hand, once, here.
 *
 * ONE BOARD PER STATE
 *
 * Amazon is one global board. Scoping each registry row to a single US state —
 * the unit the Washington page is built on — keeps a board's pagination bounded
 * (the crawl reads at most DEFAULT_MAX_JOBS of that state's roles, newest-first)
 * and makes adding a state a one-word change with no new code. Washington is the
 * only state that matters today and is the default; the free-tier database is
 * the binding constraint, so seed more states deliberately, not by reflex.
 *
 * Writes through upsertBoards, which needs the Supabase write key and applies
 * the blocklist — so run it from GitHub Actions, the same as every other seed,
 * never from a laptop holding only the read key. Re-running is idempotent: the
 * row's identity is (provider, token, site) and the state boards carry no site.
 */
import { upsertBoards, type StoredBoard } from '../corpus/board-store.js';
import { US_STATE_LABELS } from '../ats/geo.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function parseStates(): string[] {
  const raw = arg('states');
  const codes = (raw ? raw.split(',') : ['wa']).map((c) => c.trim().toUpperCase()).filter(Boolean);
  const unknown = codes.filter((c) => !US_STATE_LABELS[c]);
  if (unknown.length > 0) {
    throw new Error(`unknown state code(s): ${unknown.join(', ')} — use 2-letter codes like WA, CA, DC`);
  }
  return [...new Set(codes)];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const codes = parseStates();

  // Depth per board. Amazon holds ~4,000 roles in Washington alone, so the 300
  // default would surface a fraction; 2,000 newest-first is a deep-but-bounded
  // read (~20 pages, a few seconds of one shard, ~2 MB of the free tier).
  // Tunable with --max.
  const maxJobs = arg('max') ?? '2000';

  const boards: StoredBoard[] = codes.map((code) => ({
    provider: 'amazon',
    token: `us-${code.toLowerCase()}`,
    company: 'Amazon',
    extra: { stateName: US_STATE_LABELS[code]!, state: code, country: 'USA', maxJobs },
    source: 'amazon',
  }));

  console.log(`Amazon state boards to register (${boards.length}):`);
  for (const b of boards) {
    console.log(`  ${b.token.padEnd(8)} ${b.extra!.stateName} (${b.extra!.state})`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const stored = await upsertBoards(boards);
  console.log(`\nRegistered ${stored} Amazon board(s) (source=amazon). The next crawl reads them.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
