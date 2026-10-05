/**
 * Diffs an open ATS company dataset against the live registry and reports what
 * is net-new, per provider. Optionally verifies and stores a bounded slice.
 *
 *   npm run dataset:diff                    # report only, nothing written
 *   npm run dataset:diff -- --provider lever
 *   npm run dataset:diff -- --verify 500    # verify up to 500 new ones and store
 *   npm run dataset:diff -- --verify 500 --dry-run
 *
 * Report-only is the default and needs no write key: it reads the registry with
 * the publishable key, fetches the public MIT dataset, and prints the gap. The
 * seeding path (--verify N) needs SUPABASE_SECRET_KEY like every other writer.
 *
 * Deliberately not on a schedule. Seeding a new dataset is a measured, one-off
 * decision — run the report, read the numbers, then decide — the same way the
 * original open-dataset seed was.
 */
import { config } from '../config.js';
import { fetchDatasetBoards } from '../discovery/datasets.js';
import { freshBoards, verifyAndStore } from '../discovery/store-verified.js';
import { boardIdentity, readActiveBoards, readDeliberateRetirements } from '../corpus/board-store.js';
import type { OpenBoard } from '../discovery/opendata.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

function countByProvider(boards: readonly OpenBoard[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of boards) m.set(b.provider, (m.get(b.provider) ?? 0) + 1);
  return m;
}

async function main(): Promise<void> {
  const provider = arg('provider');
  const verifyCap = Number.parseInt(arg('verify') ?? '0', 10);
  const delayMs = Number.parseInt(arg('delay') ?? '1000', 10);
  const source = arg('source') ?? 'opendata';
  const dryRun = has('dry-run');

  console.log('Fetching the open dataset (kalil0321/ats-scrapers)…\n');
  const { boards, reports } = await fetchDatasetBoards({
    userAgent: config.userAgent,
    ...(provider ? { providerFilter: provider } : {}),
    onProgress: (file, usable) => console.log(`  ${file.padEnd(22)} ${usable.toLocaleString()} usable`),
  });
  const rows = reports.reduce((n, r) => n + r.rows, 0);
  console.log(`\n${rows.toLocaleString()} rows -> ${boards.length.toLocaleString()} addressable candidates\n`);

  const registered = await readActiveBoards();
  if (registered === null) {
    console.error('Could not read the board registry — aborting rather than guessing the gap.');
    process.exitCode = 1;
    return;
  }
  const retiredOnPurpose = await readDeliberateRetirements();
  const known = new Set([...registered, ...retiredOnPurpose].map(boardIdentity));

  const netNew = freshBoards(boards, known);

  const have = countByProvider(boards);
  const gap = countByProvider(netNew);
  console.log('net-new candidates the registry does not hold:\n');
  console.log(`  ${'provider'.padEnd(16)} ${'in dataset'.padStart(11)} ${'net-new'.padStart(9)}`);
  for (const [prov, inData] of [...have.entries()].sort((a, b) => (gap.get(b[0]) ?? 0) - (gap.get(a[0]) ?? 0))) {
    console.log(`  ${prov.padEnd(16)} ${inData.toLocaleString().padStart(11)} ${(gap.get(prov) ?? 0).toLocaleString().padStart(9)}`);
  }
  console.log(`\n  ${'TOTAL'.padEnd(16)} ${boards.length.toLocaleString().padStart(11)} ${netNew.length.toLocaleString().padStart(9)}`);

  console.log('\nsample of net-new:');
  for (const b of netNew.slice(0, 15)) {
    console.log(`  ${b.company.padEnd(26).slice(0, 26)} ${b.provider}:${b.token}${b.extra?.site ? ` (${b.extra.site})` : ''}`);
  }

  if (verifyCap <= 0) {
    console.log('\nReport only. Pass --verify N to verify and store up to N of the net-new.');
    return;
  }

  const hasKey = !!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!hasKey && !dryRun) {
    console.log(
      '\nNo SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY set — report only, not seeding.',
    );
    return;
  }

  console.log(`\nVerifying up to ${verifyCap} net-new candidates (source=${source})…\n`);
  const result = await verifyAndStore({
    candidates: netNew,
    source,
    verifyCap,
    delayMs,
    dryRun,
    ...(provider ? { provider } : {}),
    userAgent: config.userAgent,
  });
  console.log(
    `\ndone: ${result.verifiedLive} live of the ${Math.min(verifyCap, netNew.length)} checked, ` +
      `${result.stored} stored.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
