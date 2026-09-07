/**
 * Brings the seed file's boards into the registry.
 *
 *   npm run boards:adopt -- --dry-run    report what would be adopted
 *   npm run boards:adopt                 verify them and store them
 *
 * WHY THIS EXISTS
 *
 * `discovered-boards.json` is a hand-curated list written on 30 August and
 * never touched since — Cloudflare, Datadog, Supabase, Docker, Yale, Chipotle:
 * the best boards on the site. 1,287 of its 1,437 entries are NOT in the
 * `boards` table.
 *
 * They are still crawled, because loadBoardsAsync merges the file with the
 * database, so no jobs were ever lost. What was lost is control. Every registry
 * mechanism keys off a row in `boards`:
 *
 *   - recordCrawlOutcomes does UPDATE ... WHERE provider = ? AND token IN (?),
 *     which matches ZERO rows for a board that is not there — silently. So no
 *     failure is ever counted and none of them can be retired, however long
 *     they have been dead.
 *   - boards:verify reads the database, so they are never re-verified.
 *   - boards:dedupe reads the database, so they can never be merged.
 *   - every board count we publish is short by 1,287.
 *
 * And the file is a landmine: deleting it — which looks obviously safe, it is a
 * stale artefact — drops 1,287 boards out of the crawl and closes their jobs.
 *
 * Adopting them makes the registry describe what is actually crawled, which is
 * the precondition for retiring the file at all.
 *
 * WHAT IT DOES WITH A BOARD THAT DOES NOT ANSWER
 *
 * Nothing is discarded. A board that verifies dead is still recorded, as
 * `active = false` with the reason written down, so the registry keeps the
 * knowledge that it once existed rather than losing it to a deleted file. A
 * board that neither answers nor 404s is adopted ACTIVE with a clean failure
 * counter, because "no reply once" is not evidence of death — the crawler will
 * judge it over the following runs, which is exactly what that counter is for.
 */
import { config } from '../config.js';
import { verifyBoards, summariseVerification } from '../discovery/verify.js';
import { loadBoards } from '../corpus/boards.js';
import { dbWrite } from '../db/supabase.js';
import type { OpenBoard } from '../discovery/opendata.js';

const PAGE = 1000;

/**
 * A board's identity HERE is `provider:token`, lowercased.
 *
 * Deliberately NOT harvest-cc's key, which also folds in the Workday site. That
 * key describes what a board IS; this one has to describe what the table can
 * HOLD, and `boards` carries `unique (provider, token)` — one row per token,
 * whatever the site.
 *
 * The site-aware key found 1,302 "missing" boards rather than 1,287, and the
 * extra 15 were tokens the registry already holds under a different site.
 * Adopting those would not have inserted anything: it would have upserted onto
 * the existing rows and REPLACED the site of four live Workday boards — the
 * address the crawler actually fetches. A migration that silently repoints
 * working boards is worse than the problem it fixes, so they are reported.
 */
const keyOf = (b: { provider: string; token: string }) =>
  `${b.provider}:${b.token.toLowerCase()}`;

/** The Workday site each registered token currently carries, for the report. */
const registeredSite = new Map<string, string>();

async function registeredKeys(): Promise<Set<string>> {
  const client = dbWrite();
  const keys = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('boards')
      .select('provider,token,extra')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read the registry: ${error.message}`);
    const rows = (data ?? []) as unknown as { provider: string; token: string; extra?: Record<string, string> }[];
    for (const b of rows) {
      keys.add(keyOf(b));
      if (b.extra?.site) registeredSite.set(keyOf(b), b.extra.site);
    }
    if (rows.length < PAGE) break;
  }
  return keys;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // indexOf returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] —
  // the node binary path — which parses to NaN. setTimeout(NaN) fires at once,
  // so the whole pass ran flat out instead of one request a second. It happened
  // to survive (1,273 of 1,287 answered), but pacing that silently turns itself
  // off against a vendor that drops bursts is how 2,263 live boards were once
  // recorded as dead.
  const delayFlag = process.argv.indexOf('--delay');
  const delayRaw = delayFlag === -1 ? undefined : process.argv[delayFlag + 1];
  const parsed = Number.parseInt(delayRaw ?? '', 10);
  const delayMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;

  const file = loadBoards();
  // EVERY board in the registry, active or not. Comparing against active rows
  // alone would re-adopt something deliberately retired — including the 318 the
  // dedupe merged, which would undo that work in one run.
  const known = await registeredKeys();
  const missing = file.filter((b) => !known.has(keyOf(b)));

  console.log(`seed file: ${file.length} boards`);
  console.log(`registry : ${known.size} boards`);
  console.log(`missing from the registry: ${missing.length}\n`);
  // Same token, a different Workday site. Not adopted — see keyOf. Printed
  // because at least one of them is a registry bug worth a human look.
  const clashes = file.filter((b) => {
    if (b.provider !== 'workday' || !known.has(keyOf(b))) return false;
    const site = (b.extra?.site ?? '').toLowerCase();
    return site !== '' && site !== (registeredSite.get(keyOf(b)) ?? '').toLowerCase();
  });
  if (clashes.length > 0) {
    console.log(`${clashes.length} Workday token(s) already registered under a DIFFERENT site — left alone:`);
    for (const b of clashes) {
      console.log(`  ${b.token}: registry "${registeredSite.get(keyOf(b))}" vs file "${b.extra?.site}"`);
    }
    console.log('');
  }

  if (missing.length === 0) {
    console.log('Nothing to adopt. The registry already covers the file.');
    return;
  }

  const byProvider = new Map<string, number>();
  for (const b of missing) byProvider.set(b.provider, (byProvider.get(b.provider) ?? 0) + 1);
  for (const [p, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(18)} ${n}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing verified, nothing written.');
    return;
  }

  const batch: OpenBoard[] = missing.map((b) => ({
    provider: b.provider,
    token: b.token,
    company: b.company,
    ...(b.extra ? { extra: b.extra } : {}),
  }));

  console.log(`\nVerifying ${batch.length}, ${delayMs}ms apart (~${Math.round((batch.length * delayMs) / 60_000)} min)…`);
  const results = await verifyBoards(batch, {
    userAgent: config.userAgent,
    delayMs,
    onResult: (_r, done, total) => {
      if (done % 50 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`);
    },
  });
  console.log('\n' + summariseVerification(results));

  const live = results.filter((r) => r.verdict === 'live');
  const dead = results.filter((r) => r.verdict === 'dead');
  // 'unknown' is the verifier's word for it: no HTTP status came back at all.
  const unclear = results.filter((r) => r.verdict === 'unknown');

  // Live and unclear both become active rows. upsertBoards applies the
  // blocklist, so a board someone deliberately banned cannot come back in
  // through this door.
  const { upsertBoards } = await import('../corpus/board-store.js');
  const stored = await upsertBoards(
    [...live, ...unclear].map((r) => ({
      provider: r.board.provider,
      token: r.board.token,
      company: r.board.company,
      extra: r.board.extra ?? {},
      source: 'seed-file',
      jobCount: r.jobs,
      ...((r as { domain?: string }).domain ? { domain: (r as { domain?: string }).domain! } : {}),
    })),
  );
  console.log(`\nAdopted ${stored} board(s) as active (${live.length} answered, ${unclear.length} unclear).`);

  // Recorded rather than dropped: the file is going away, and losing the fact
  // that these ever existed would mean rediscovering and re-verifying them.
  if (dead.length > 0) {
    const client = dbWrite();
    const today = new Date().toISOString().slice(0, 10);
    let recorded = 0;
    for (let i = 0; i < dead.length; i += 100) {
      const rows = dead.slice(i, i + 100).map((r) => ({
        provider: r.board.provider,
        token: r.board.token,
        company: r.board.company,
        extra: r.board.extra ?? {},
        active: false,
        source: 'seed-file',
        job_count: 0,
        verified_at: new Date().toISOString(),
        last_error: `adopted from the seed file, verified gone ${today} (HTTP ${r.status ?? '?'})`,
      }));
      const { error } = await client.from('boards').upsert(rows, { onConflict: 'provider,token' });
      if (error) console.error(`could not record dead boards: ${error.message}`);
      else recorded += rows.length;
    }
    console.log(`Recorded ${recorded} board(s) as retired, with the reason.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
