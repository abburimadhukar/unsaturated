/**
 * Harvests board tokens from apply URLs and reports ingest coverage.
 *
 *   cat apply-urls.txt | npm run resolve
 *   cat apply-urls.txt | npm run resolve -- --save
 *
 * The coverage table is the input to the targeting decision: it says which
 * platforms actually carry the volume, and therefore which adapter to build next.
 */
import { summarizeCoverage } from '../ats/resolve.js';
import { closePool } from '../db/client.js';
import { upsertBoard } from '../ingest/crawler.js';

async function readStdin(): Promise<string[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

async function main(): Promise<void> {
  const save = process.argv.includes('--save');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const urls = [...args, ...(await readStdin())].map((s) => s.trim()).filter(Boolean);

  if (urls.length === 0) {
    console.error('No URLs supplied. Pass them as arguments or pipe them on stdin.');
    process.exitCode = 1;
    return;
  }

  const { total, supported, byPlatform, boards } = summarizeCoverage(urls);

  const rows = Object.entries(byPlatform).sort((a, b) => b[1].count - a[1].count);
  const width = Math.max(...rows.map(([name]) => name.length), 8);

  console.log(`\n${'platform'.padEnd(width)}  ${'count'.padStart(6)}  ${'share'.padStart(6)}  tier`);
  console.log('-'.repeat(width + 30));
  for (const [name, { count, tier }] of rows) {
    const share = `${((count / total) * 100).toFixed(1)}%`;
    console.log(`${name.padEnd(width)}  ${String(count).padStart(6)}  ${share.padStart(6)}  ${tier}`);
  }

  console.log(
    `\n${supported}/${total} URLs (${((supported / total) * 100).toFixed(1)}%) are ingestible today ` +
      `across ${boards.length} distinct boards.`,
  );

  if (save) {
    let saved = 0;
    for (const board of boards) {
      if (await upsertBoard(board)) saved++;
    }
    console.log(`Registered ${saved} boards.`);
  } else if (boards.length > 0) {
    console.log('Re-run with --save to register these boards for crawling.');
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
