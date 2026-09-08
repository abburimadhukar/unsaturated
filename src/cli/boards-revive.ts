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
 * IT HAPPENED AGAIN, AND THAT IS WHY THIS FILE NO LONGER READS ERROR TEXT.
 *
 * This tool used to decide by pattern-matching the stored `last_error` against
 * a list of refusal-shaped strings. Two things were wrong with that.
 *
 * First, the text was often somebody else's: one message was written across a
 * whole batch, so 44 of the 74 retired boards with an attributable error named a
 * DIFFERENT board. Fixed now, in board-store.ts — but a decision this permanent
 * should not rest on prose at all.
 *
 * Second, and worse, the pattern could only recognise refusals it had been told
 * about. Workday does not refuse with a status code; it serves an HTML challenge
 * page where JSON belongs, the parser reports `Unexpected token '<'`, and no
 * rule here matched that. 44 live companies holding 7,871 jobs sat retired
 * because of a gap in a regex, and the tool built to rescue them could see 3 of
 * the 411. Widening the pattern would fix those 44 and be equally blind to the
 * next shape nobody has met yet.
 *
 * So the pattern is gone. THE BOARD IS ASKED. Every retired board that was not
 * deliberately switched off is fetched from its vendor at one request a second,
 * and a board comes back only if it answers, right now, with a payload that
 * parses. That cannot be blindsided by a refusal nobody has seen before, and it
 * needs no maintenance when a vendor invents a new way of saying no.
 *
 * TWO KINDS OF RETIREMENT ARE NEVER RECONSIDERED, because they are decisions
 * rather than failures:
 *
 *   - `duplicate spelling of X` — boards-dedupe found the same board registered
 *     twice under two spellings and switched one off. All 330 of these point at
 *     a board that is still active, verified 8 Sep. Reviving one would crawl the
 *     company twice and store every posting under two keys, which is the bug
 *     dedupe exists to prevent.
 *   - anything in `blocked_boards` — aggregators that republish other people's
 *     jobs, and MLM recruiting. Somebody removed these on purpose and wrote down
 *     why. jobgether answers 200 with 4,534 jobs; answering is not the question.
 *
 * A parse is required, not merely a 200. `teamtailor:app`, `discover` and
 * `integrations` are Teamtailor's own marketing subdomains and answer 200 with a
 * landing page, which counts as zero jobs — indistinguishable from a real board
 * with nothing open unless you ask whether the body was JSON at all.
 */
import { config } from '../config.js';
import { db, dbWrite } from '../db/supabase.js';
import { verifyBoards } from '../discovery/verify.js';
// The rules live in their own module: importing a CLI runs it, and a test that
// reached in here for them would start a live pass over the registry.
import { isDeliberateRetirement, shouldRevive } from '../corpus/revival.js';
import type { OpenBoard } from '../discovery/opendata.js';

const PAGE = 1000;

interface Row {
  provider: string;
  token: string;
  company: string | null;
  site: string | null;
  extra: Record<string, string> | null;
  last_error: string | null;
  job_count: number | null;
}

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function readRetired(): Promise<Row[]> {
  const client = db();
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('boards')
      .select('provider,token,company,site,extra,last_error,job_count')
      .eq('active', false)
      .order('provider', { ascending: true })
      .order('token', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`could not read retired boards: ${error.message}`);
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number.parseInt(arg('limit') ?? '0', 10);

  const retired = await readRetired();

  const { loadBlocklist, blockKey } = await import('../corpus/blocklist.js');
  const blocked = await loadBlocklist();

  const deliberate = retired.filter((b) => isDeliberateRetirement(b.last_error));
  const onBlocklist = retired.filter(
    (b) => !isDeliberateRetirement(b.last_error) && blocked.has(blockKey(b.provider, b.token)),
  );
  let candidates = retired.filter(
    (b) => !isDeliberateRetirement(b.last_error) && !blocked.has(blockKey(b.provider, b.token)),
  );
  if (limit > 0) candidates = candidates.slice(0, limit);

  console.log(`${retired.length} retired boards`);
  console.log(`  ${deliberate.length} switched off as duplicate spellings — never reconsidered`);
  console.log(`  ${onBlocklist.length} on the blocklist — never reconsidered`);
  console.log(`  ${candidates.length} to ask\n`);
  if (candidates.length === 0) return;

  // One request a second, the same rate the verification pass uses, because
  // Greenhouse drops bursts from datacenter IPs and a dropped connection read as
  // a verdict is how this whole mess started.
  const results = await verifyBoards(
    candidates.map(
      (b): OpenBoard => ({
        provider: b.provider as OpenBoard['provider'],
        token: b.token,
        company: b.company ?? b.token,
        // Workday needs host + site and UKG needs host + board, or `endpoint()`
        // cannot build a URL and the board comes back 'unknown' — which reads as
        // "leave it retired" and would quietly exclude every Workday board, the
        // exact population this exists to rescue.
        ...(b.extra && Object.keys(b.extra).length > 0 ? { extra: b.extra } : {}),
      }),
    ),
    {
      userAgent: config.userAgent,
      delayMs: 1000,
      onResult: (_r, done, total) => {
        if (done % 10 === 0 || done === total) process.stdout.write(`  asked ${done}/${total}\r`);
      },
    },
  );

  const back = results.filter(shouldRevive);
  const stay = results.filter((r) => !shouldRevive(r));

  console.log(`\n\n  ${back.length} answered and will come back:`);
  for (const r of [...back].sort((a, b) => b.jobs - a.jobs)) {
    console.log(
      `    ${`${r.board.provider}:${r.board.token}`.padEnd(34)} ${String(r.jobs).padStart(5)} jobs`,
    );
  }

  if (stay.length > 0) {
    console.log(`\n  ${stay.length} stay retired:`);
    for (const r of stay) {
      const why =
        r.verdict === 'dead'
          ? `HTTP ${r.status}`
          : r.status === null
            ? 'no answer'
            : r.parsed === false
              ? `HTTP ${r.status} but the body is not JSON — not a board`
              : `HTTP ${r.status}, unclear`;
      console.log(`    ${`${r.board.provider}:${r.board.token}`.padEnd(34)} ${why}`);
    }
  }

  const jobs = back.reduce((n, r) => n + r.jobs, 0);
  console.log(`\n  they are carrying ${jobs.toLocaleString()} jobs right now`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  if (back.length === 0) return;

  // Reactivated AND reset to zero failures. Bringing a board back still sitting
  // on four strikes would retire it again on its next unlucky hour, which is the
  // loop this exists to break.
  //
  // Chunked because these become query-string parameters, and scoped by provider
  // because tokens are only unique within one.
  const client = dbWrite();
  const CHUNK = 150;
  const byProvider = new Map<string, string[]>();
  for (const r of back) {
    const list = byProvider.get(r.board.provider) ?? [];
    list.push(r.board.token);
    byProvider.set(r.board.provider, list);
  }

  let revived = 0;
  for (const [provider, tokens] of byProvider) {
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
