/**
 * Fills jobs.region for rows already in the database.
 *
 *   npm run backfill:region -- --dry-run     report only, write nothing
 *   npm run backfill:region -- --limit 5000  stop after N rows read
 *   npm run backfill:region                  one pass over every open US row
 *
 * Why this exists: the crawl writes `region` as it reads each board, but a row
 * is only rewritten when its board is next crawled, so without this the
 * Washington page would fill in over days as the corpus turned over. This reads
 * the state straight from the location already stored and writes it now.
 *
 * It walks every open US posting once, keyed ascending, rather than relying on
 * the match set shrinking as it writes — because a genuinely stateless US
 * location ("Remote, US") never gets a region, so a shrinking-filter loop would
 * read those same rows forever. Walking by key terminates regardless and still
 * resumes roughly where it left off, since finished rows sort behind the cursor.
 *
 * Two deliberate limits, the same as backfill:spec:
 *
 *   It never writes crawl_runs and never touches last_seen_at. Freshness is
 *   decided by the newest finished crawl; a backfill stamping that would report
 *   a stale corpus as current.
 *
 *   It reads only the STORED location, which is already cleaned and truncated.
 *   Where cleaning dropped the state the region stays null and the next crawl —
 *   which has the raw location — fills it. An honest blank beats a guess.
 */
import { dbWrite } from '../db/supabase.js';
import { inferUsState } from '../ats/geo.js';

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Rows read per pass. Supabase caps a select at 1000. */
const PAGE = 1000;

/** Keys per UPDATE. Postgres handles far more; this keeps a failure small. */
const CHUNK = 200;

interface Row {
  key: string;
  location: string | null;
  country: string | null;
  region: string | null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number.parseInt(argOf('limit') ?? '', 10);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;

  const client = dbWrite();
  let seen = 0;
  let written = 0;
  const counts = new Map<string, number>();

  console.log('Backfilling jobs.region from stored locations…');
  if (dryRun) console.log('--dry-run: nothing will be written.\n');

  // Keyset cursor. '' sorts before every real key, so the first page starts at
  // the beginning and each later page resumes just past the last key seen.
  let after = '';
  for (;;) {
    if (seen >= cap) break;

    const { data, error } = await client
      .from('jobs')
      .select('key,location,country,region')
      .is('closed_at', null)
      .eq('country', 'US')
      .gt('key', after)
      .order('key', { ascending: true })
      .limit(Math.min(PAGE, cap - seen));

    if (error) throw new Error(`read failed: ${error.message}`);
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;

    after = rows[rows.length - 1]!.key;
    seen += rows.length;

    // Group the rows whose region needs changing by the value to write, so a
    // thousand rows become a handful of UPDATEs. A row already carrying the
    // right region is left alone; a row whose state can no longer be read has
    // its stale region cleared to null, the same way the crawl would.
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      const next = inferUsState(r.location ?? undefined, r.country ?? undefined) ?? null;
      if (next) counts.set(next, (counts.get(next) ?? 0) + 1);
      if (next === r.region) continue;
      const bucket = next ?? '__null__';
      let arr = groups.get(bucket);
      if (!arr) groups.set(bucket, (arr = []));
      arr.push(r.key);
    }

    if (dryRun) {
      console.log(`read ${rows.length}; ${[...groups.values()].reduce((a, b) => a + b.length, 0)} would change in this page.`);
      break;
    }

    for (const [bucket, keys] of groups) {
      const value = bucket === '__null__' ? null : bucket;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const chunk = keys.slice(i, i + CHUNK);
        const { error: writeError } = await client
          .from('jobs')
          .update({ region: value })
          .in('key', chunk);
        // Never silently: a failed chunk that only failed to increment a counter
        // is indistinguishable from having had nothing to do.
        if (writeError) throw new Error(`write failed: ${writeError.message}`);
        written += chunk.length;
      }
    }
    process.stdout.write(`  ${seen} read · ${written} written\r`);
  }

  console.log(`\n\nread ${seen} · wrote ${written}\n`);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [state, n] of sorted.slice(0, 15)) {
    console.log(`  ${state.padEnd(4)} ${String(n).padStart(7)}`);
  }
  if (sorted.length > 15) console.log(`  … ${sorted.length - 15} more states`);
}

main().catch((err) => {
  console.error('backfill failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
