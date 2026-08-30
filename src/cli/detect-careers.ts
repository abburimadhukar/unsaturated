/**
 * Reads company careers pages to find their ATS, instead of guessing a slug.
 *
 *   npm run detect -- --file domains.txt
 *   npm run detect -- --universities
 *   npm run detect -- --dry-run
 *
 * Finds boards the slug-prober structurally cannot: Ohio State's Workday tenant
 * is "osu" with a site called "OSUCareers", which no naming rule reaches.
 * Results merge into discovered-boards.json; existing entries are never
 * overwritten.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { detectMany } from '../discovery/careers.js';
import { UNIVERSITY_DOMAINS } from '../discovery/universities.js';

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

/** "osu.edu" -> "Osu" is poor; prefer the token the ATS itself uses. */
function labelFor(domain: string, token: string): string {
  const base = domain.replace(/^www\./, '').replace(/\.(edu|com|org|net|gov)$/, '');
  const source = base.length >= token.length ? base : token;
  return source
    .replace(/[._-]+/g, ' ')
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

async function main(): Promise<void> {
  const file = arg('file');
  const dryRun = process.argv.includes('--dry-run');
  const limitRaw = arg('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 0;

  let domains: string[];
  if (file) {
    domains = (await readFile(file, 'utf8')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else {
    domains = UNIVERSITY_DOMAINS;
  }
  if (limit > 0) domains = domains.slice(0, limit);

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
  console.log(`${existing.size} boards already known`);
  console.log(`Reading ${domains.length} careers pages…\n`);

  const results = await detectMany(domains, 6, (done, total, found) => {
    if (done % 10 === 0 || done === total) {
      process.stdout.write(`  ${done}/${total} checked · ${found} with a detectable ATS\r`);
    }
  });

  const hits = results.filter((r) => r.boards.length > 0);
  console.log(`\n\n${hits.length}/${results.length} domains exposed an ATS we can read`);

  const byProvider = new Map<string, number>();
  const fresh: StoredBoard[] = [];
  for (const r of hits) {
    for (const b of r.boards) {
      byProvider.set(b.provider, (byProvider.get(b.provider) ?? 0) + 1);
      const key = `${b.provider}:${b.token}`;
      if (existing.has(key)) continue;
      const entry: StoredBoard = { provider: b.provider, token: b.token, company: labelFor(r.domain, b.token) };
      if (b.extra) entry.extra = b.extra;
      fresh.push(entry);
    }
  }

  for (const [p, n] of [...byProvider.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(18)} ${n}`);
  }
  console.log(`\n${fresh.length} of them are new:`);
  for (const f of fresh.slice(0, 15)) {
    console.log(`  ${f.company.padEnd(24).slice(0, 24)} ${f.provider}:${f.token}${f.extra?.site ? ` (${f.extra.site})` : ''}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const before = existing.size;
  for (const f of fresh) existing.set(`${f.provider}:${f.token}`, f);
  await writeFile(OUT, JSON.stringify([...existing.values()], null, 2), 'utf8');
  console.log(`\n${existing.size} boards in ${OUT} (${before} before, +${existing.size - before} new)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
