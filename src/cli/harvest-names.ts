/**
 * Harvests company names from public job APIs, then probes them for ATS boards.
 *
 *   npm run harvest:names                  # depth 10 per paged source
 *   npm run harvest:names -- --depth 20
 *   npm run harvest:names -- --limit 300   # cap how many names get probed
 *   npm run harvest:names -- --names-only  # just list names, no probing
 *
 * Merges into discovered-boards.json; existing entries are never overwritten.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { harvestCompanyNames } from '../discovery/aggregators.js';
import { discoverAll } from '../discovery/probe.js';

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

async function main(): Promise<void> {
  const depth = Number.parseInt(arg('depth') ?? '10', 10);
  const limit = Number.parseInt(arg('limit') ?? '0', 10);
  const namesOnly = process.argv.includes('--names-only');

  const existing = new Map<string, StoredBoard>();
  const knownCompanies = new Set<string>();
  if (existsSync(OUT)) {
    try {
      for (const b of JSON.parse(await readFile(OUT, 'utf8')) as StoredBoard[]) {
        existing.set(`${b.provider}:${b.token}`, b);
        knownCompanies.add(b.company.toLowerCase());
      }
    } catch {
      // Corrupt file — start clean rather than abort.
    }
  }
  console.log(`${existing.size} boards already known\n`);

  console.log(`Harvesting company names (depth ${depth})…`);
  const { bySource, names } = await harvestCompanyNames(depth, (src, n) => {
    console.log(`  ${src.padEnd(12)} +${n}`);
  });

  // Skip employers already in the registry — re-probing them is pure waste.
  let fresh = names.filter((n) => !knownCompanies.has(n.toLowerCase()));
  console.log(`\n${names.length} names harvested · ${fresh.length} not already known`);
  console.log('  by source: ' + Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(' · '));

  if (namesOnly) {
    console.log('\n' + fresh.slice(0, 40).join(' · '));
    console.log('\n--names-only: nothing probed.');
    return;
  }

  if (limit > 0 && fresh.length > limit) {
    console.log(`  capped to ${limit}`);
    fresh = fresh.slice(0, limit);
  }
  if (fresh.length === 0) {
    console.log('Nothing new to probe.');
    return;
  }

  // Workday is skipped: its shard x site matrix costs ~20 requests per company
  // and these names are overwhelmingly small remote-first employers, which are
  // never on Workday.
  console.log(`\nProbing ${fresh.length} companies…`);
  const stats = await discoverAll(
    fresh,
    8,
    (done, total, found) => {
      if (done % 25 === 0 || done === total) {
        process.stdout.write(`  ${done}/${total} probed · ${found} boards\r`);
      }
    },
    false,
  );

  console.log(`\n\nFOUND ${stats.found.length}/${stats.companiesTried} (${Math.round((stats.found.length / stats.companiesTried) * 100)}%)`);
  const byProvider = new Map<string, number>();
  for (const d of stats.found) byProvider.set(d.provider, (byProvider.get(d.provider) ?? 0) + 1);
  for (const [p, n] of [...byProvider.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(18)} ${n}`);
  }

  const before = existing.size;
  for (const d of stats.found) {
    const entry: StoredBoard = { provider: d.provider, token: d.token, company: d.company };
    if (d.extra) entry.extra = d.extra;
    existing.set(`${d.provider}:${d.token}`, entry);
  }
  await writeFile(OUT, JSON.stringify([...existing.values()], null, 2), 'utf8');
  console.log(`\n${existing.size} boards in ${OUT} (${before} before, +${existing.size - before} new)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
