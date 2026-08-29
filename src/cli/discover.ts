/**
 * Finds real ATS boards for a list of companies.
 *
 *   npm run discover                    # tech seed list
 *   npm run discover -- --enterprise    # banks, hospitals, insurers, defense
 *   npm run discover -- --all           # both
 *   npm run discover -- --limit 40
 *   npm run discover -- --file names.txt
 *
 * Results are MERGED into discovered-boards.json, so running it repeatedly with
 * different lists accumulates coverage rather than replacing it.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SEED_COMPANIES } from '../discovery/companies.js';
import { ENTERPRISE_COMPANIES } from '../discovery/enterprises.js';
import { SCALE_COMPANIES } from '../discovery/scale.js';
import { SCALE2_COMPANIES } from '../discovery/scale2.js';
import { discoverAll } from '../discovery/probe.js';

interface StoredBoard {
  provider: string;
  token: string;
  company: string;
  extra?: Record<string, string>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const OUT = 'discovered-boards.json';

async function main(): Promise<void> {
  const file = arg('file');
  const limitRaw = arg('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

  let companies: string[];
  if (file) {
    const text = await readFile(file, 'utf8');
    companies = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else if (flag('scale2')) {
    companies = SCALE2_COMPANIES;
  } else if (flag('scale')) {
    companies = SCALE_COMPANIES;
  } else if (flag('all')) {
    companies = [...SEED_COMPANIES, ...ENTERPRISE_COMPANIES, ...SCALE_COMPANIES, ...SCALE2_COMPANIES];
  } else if (flag('enterprise')) {
    companies = ENTERPRISE_COMPANIES;
  } else {
    companies = SEED_COMPANIES;
  }
  if (limit && Number.isFinite(limit)) companies = companies.slice(0, limit);

  console.log(`Probing ${companies.length} companies across 8 ATS providers…\n`);
  const started = Date.now();

  const withWorkday = !flag('no-workday');
  const stats = await discoverAll(companies, 8, (done, total, found) => {
    if (done % 10 === 0 || done === total) {
      process.stdout.write(`  ${done}/${total} probed · ${found} boards found\r`);
    }
  }, withWorkday);

  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n\nDone in ${seconds}s — ${stats.requestsMade} probe rounds.\n`);

  const byProvider = new Map<string, number>();
  for (const d of stats.found) {
    byProvider.set(d.provider, (byProvider.get(d.provider) ?? 0) + 1);
  }
  console.log(`FOUND ${stats.found.length}/${stats.companiesTried} companies:`);
  for (const [provider, count] of [...byProvider.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${provider.padEnd(18)} ${count}`);
  }

  // Merge with anything already discovered so separate runs accumulate.
  const merged = new Map<string, StoredBoard>();
  if (existsSync(OUT)) {
    try {
      const existing = JSON.parse(await readFile(OUT, 'utf8')) as StoredBoard[];
      for (const b of existing) merged.set(`${b.provider}:${b.token}`, b);
    } catch {
      // Corrupt file — start clean rather than abort the run.
    }
  }
  const before = merged.size;

  for (const d of stats.found) {
    const entry: StoredBoard = { provider: d.provider, token: d.token, company: d.company };
    if (d.extra) entry.extra = d.extra;
    merged.set(`${d.provider}:${d.token}`, entry);
  }

  const out = [...merged.values()];
  await writeFile(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n${out.length} boards in ${OUT} (${before} before, +${out.length - before} new)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
