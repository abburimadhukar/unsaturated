/**
 * Brings back boards that were retired for refusing us rather than for dying.
 *
 *   npm run boards:revive -- --dry-run     report what would come back
 *   npm run boards:revive                  bring them back
 *
 * On 6 September 2026 the crawler retired 2,263 boards in an afternoon. 2,185
 * of them carried an HTTP 429 — a rate limit — against 16 that were genuinely
 * 404. Six sampled at random answered 200 with between 3 and 86 live jobs still
 * on them. They were not dead; we asked too fast and then punished them for it.
 *
 * The cause is fixed in the crawler: a refusal no longer advances the counter
 * that ends in deactivation. This undoes the damage that was already done.
 *
 * Deliberately narrow. It revives a board only when the recorded error names a
 * refusal — a rate limit, a server error, a timeout, a dropped connection. A
 * board retired for a 404 stays retired, because that one really is gone.
 */
import { dbWrite } from '../db/supabase.js';

/**
 * Errors that mean "not now", never "not there".
 *
 * Matched against the stored last_error text. 403 is included on purpose: it
 * is nearly always user-agent filtering, which is a door being held shut rather
 * than a building that has been demolished.
 */
const REFUSAL = /\b(429|500|502|503|504|403|408)\b|timed out|timeout|ECONNRESET|socket hang up|fetch failed|network/i;

const PAGE = 1000;

interface Row {
  provider: string;
  token: string;
  last_error: string | null;
  job_count: number | null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const client = dbWrite();

  const retired: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('boards')
      .select('provider,token,last_error,job_count')
      .eq('active', false)
      .order('provider', { ascending: true })
      .order('token', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read retired boards: ${error.message}`);
    const batch = (data ?? []) as unknown as Row[];
    retired.push(...batch);
    if (batch.length < PAGE) break;
  }

  const revivable = retired.filter((b) => b.last_error && REFUSAL.test(b.last_error));
  const staysDead = retired.length - revivable.length;

  const byProvider = new Map<string, number>();
  for (const b of revivable) byProvider.set(b.provider, (byProvider.get(b.provider) ?? 0) + 1);

  console.log(`${retired.length} retired boards`);
  console.log(`  ${revivable.length} were refused, not gone — these come back`);
  console.log(`  ${staysDead} stay retired (a real 404, or no reason recorded)\n`);
  for (const [p, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${p.padEnd(18)} ${n}`);
  }
  const jobs = revivable.reduce((n, b) => n + (b.job_count ?? 0), 0);
  console.log(`\n  they were carrying ${jobs.toLocaleString()} jobs when last verified`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  if (revivable.length === 0) return;

  // Reactivated AND reset to zero failures. Bringing a board back still sitting
  // on four strikes would retire it again on its next unlucky hour, which is
  // the loop this exists to break.
  //
  // Chunked because these become query-string parameters, and scoped by
  // provider because tokens are only unique within one.
  const CHUNK = 150;
  let revived = 0;
  const byProv = new Map<string, string[]>();
  for (const b of revivable) {
    const list = byProv.get(b.provider) ?? [];
    list.push(b.token);
    byProv.set(b.provider, list);
  }

  for (const [provider, tokens] of byProv) {
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const { error, count } = await client
        .from('boards')
        .update(
          { active: true, consecutive_failures: 0, last_error: null },
          { count: 'exact' },
        )
        .eq('provider', provider)
        .in('token', tokens.slice(i, i + CHUNK));
      if (error) {
        console.error(`revive failed for ${provider}: ${error.message}`);
        continue;
      }
      revived += count ?? 0;
    }
  }

  console.log(`\nRevived ${revived} boards. The next crawl will read them again.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
