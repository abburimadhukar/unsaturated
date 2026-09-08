import { db, dbWrite } from '../db/supabase.js';
import type { AtsProvider } from '../ats/types.js';
import type { CorpusBoard } from './boards.js';

/**
 * The board registry, in Supabase.
 *
 * discovered-boards.json worked at 1,437 boards and does not at 15,000: it would
 * be several megabytes of git-tracked JSON where every discovery run produces an
 * unreviewable diff, and the crawler would have to ship the whole file to read
 * one row. The `boards` table already existed in the schema and had never been
 * used; this is what it is for.
 *
 * The file stays as an offline fallback. A clean checkout with no database still
 * runs, which is what kept development pleasant in the first place.
 */

const PAGE = 1000;

export interface StoredBoard {
  provider: AtsProvider;
  token: string;
  company: string;
  extra?: Record<string, string>;
  source?: string;
  jobCount?: number;
  domain?: string;
}

interface BoardRow {
  provider: string;
  token: string;
  company: string;
  extra: Record<string, string> | null;
  active: boolean;
}

/**
 * Every board the crawler should read.
 *
 * Returns null rather than an empty array when the table is unreachable or
 * empty, so the caller can fall back to the file instead of crawling nothing.
 */
export async function readActiveBoards(): Promise<CorpusBoard[] | null> {
  try {
    const client = db();
    const rows: BoardRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from('boards')
        .select('provider,token,company,extra,active')
        .eq('active', true)
        // Stable order so paging cannot duplicate or skip across requests.
        .order('provider', { ascending: true })
        .order('token', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        console.error('board registry read failed:', error.message);
        return null;
      }
      const batch = (data ?? []) as unknown as BoardRow[];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    if (rows.length === 0) return null;

    return rows.map((r) => ({
      provider: r.provider as AtsProvider,
      token: r.token,
      company: r.company,
      ...(r.extra && Object.keys(r.extra).length > 0 ? { extra: r.extra } : {}),
    }));
  } catch (err) {
    console.error('board registry unavailable:', err);
    return null;
  }
}

/**
 * The boards least recently confirmed working, oldest first.
 *
 * The re-verification pass used to take the first N of the crawl list, which is
 * sorted by provider then token — so it re-checked the same alphabetical head
 * every week and never reached the other 11,612. It got as far as "ashby:ez…"
 * and stopped, meaning no Greenhouse, Lever or Workday board was ever
 * re-verified, and a dead one there would fail on every crawl forever while the
 * pass reported "0 retired" and looked healthy.
 *
 * Ordering by last_ok_at with nulls first makes the window rotate: each run picks
 * up where the last left off and works round the whole registry.
 */
export async function readStalestBoards(limit: number): Promise<CorpusBoard[]> {
  try {
    const { data, error } = await db()
      .from('boards')
      .select('provider,token,company,extra')
      .eq('active', true)
      .order('last_ok_at', { ascending: true, nullsFirst: true })
      .order('token', { ascending: true })
      .limit(limit);
    if (error) {
      console.error('stale board read failed:', error.message);
      return [];
    }
    return (data as BoardRow[]).map((r) => ({
      provider: r.provider as AtsProvider,
      token: r.token,
      company: r.company,
      ...(r.extra && Object.keys(r.extra).length > 0 ? { extra: r.extra } : {}),
    }));
  } catch (err) {
    console.error('stale board read unavailable:', err);
    return [];
  }
}

/** Adds or refreshes boards. Only ever called by CLIs holding the secret key. */
/**
 * What makes two board records the same board.
 *
 * Provider and token, folded to lower case because these APIs are — greenhouse
 * `babylist` and `Babylist` return the same 46 jobs — PLUS the Workday site.
 *
 * The site matters because a Workday token is a TENANT, not a board. The Nevada
 * System of Higher Education is one tenant running a portal per campus, and
 * those portals share no job ids at all: `GBC-external` is Great Basin College
 * with 18 jobs, `UNR-external` is the University of Nevada, Reno with 133.
 *
 * Leaving the site out of this key is what discarded them. Across three
 * discovery runs, 765 live boards found and 352 stored, 843 and 414, 906 and
 * 442 — roughly 430 verified-live Workday boards collapsed onto an existing
 * tenant every run. Discovery had been finding them correctly the whole time.
 *
 * Empty for every other provider, so their identity is unchanged.
 */
export function boardIdentity(b: { provider: string; token: string; extra?: Record<string, string> }): string {
  const site = (b.extra?.site ?? '').toLowerCase();
  return `${b.provider}:${b.token.toLowerCase()}:${site}`;
}

export async function upsertBoards(boards: StoredBoard[]): Promise<number> {
  if (boards.length === 0) return 0;

  // Refuse blocked boards at the point of storage, so discovery cannot re-add an
  // aggregator that was deliberately removed. Filtering only at crawl time would
  // leave them accumulating in the registry and reappearing on every audit.
  const { loadBlocklist, blockKey } = await import('./blocklist.js');
  const blocked = await loadBlocklist();
  const allowed = boards.filter((b) => !blocked.has(blockKey(b.provider, b.token)));
  const refused = boards.length - allowed.length;
  if (refused > 0) console.log(`skipped ${refused} blocked board(s)`);
  if (allowed.length === 0) return 0;
  boards = allowed;

  const client = dbWrite();
  const now = new Date().toISOString();

  // Deduplicate before writing: Postgres rejects an upsert that touches the same
  // row twice in one statement, and a company can appear in two source files.
  //
  // CASE-INSENSITIVELY, because that is what a board's identity is here — these
  // APIs return the same jobs for `cleric` and `Cleric`. This key was case
  // sensitive, and the seed file happens to contain both spellings of ten
  // companies, so adopting it inserted `cleric` AND `Cleric` as separate active
  // boards: two rows, two crawls, and every posting stored twice under two job
  // keys. Twelve pairs were created in one run before this was folded.
  //
  // The last spelling wins, which is arbitrary and fine — they address the same
  // board. What matters is that only one is written.
  const byKey = new Map<string, StoredBoard>();
  for (const b of boards) byKey.set(boardIdentity(b), b);

  const rows = [...byKey.values()].map((b) => ({
    provider: b.provider,
    token: b.token,
    company: b.company,
    extra: b.extra ?? {},
    active: true,
    source: b.source ?? 'manual',
    domain: b.domain ?? null,
    job_count: b.jobCount ?? 0,
    verified_at: now,
    last_ok_at: now,
    consecutive_failures: 0,
  }));

  let written = 0;
  const CHUNK = 500;
  // Conflict on the site as well, so one Workday tenant can hold every one of
  // its career sites. Migrations here are applied by hand, so the code and the
  // schema are briefly out of step by design: if `site` is not there yet, fall
  // back to the old target and say so, rather than failing every run in between.
  let target = 'provider,token,site';
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    let { error, count } = await client
      .from('boards')
      .upsert(chunk, { onConflict: target, count: 'exact' });

    if (error && target !== 'provider,token' && /site/.test(error.message)) {
      console.error(
        'boards.site does not exist yet — conflicting on (provider, token) instead. ' +
          'Apply src/db/migrations/2026-09-07-workday-sites.sql, or a Workday tenant ' +
          'keeps only one of its career sites.',
      );
      target = 'provider,token';
      ({ error, count } = await client
        .from('boards')
        .upsert(chunk, { onConflict: target, count: 'exact' }));
    }
    if (error) throw new Error(`board upsert failed: ${error.message}`);
    written += count ?? chunk.length;
  }
  return written;
}

/**
 * Records the outcome of a crawl so persistently broken boards drop out.
 *
 * Called by the hourly crawl and by the weekly re-verification. Until it was
 * wired into the crawl, `last_crawled_at` was NULL on all 12,479 boards and
 * `consecutive_failures` was 0 on every one of them — so no board could ever
 * retire from crawl failures, and "crawled and empty" was indistinguishable
 * from "never reached". The only cleanup path was the weekly 600-board check,
 * which needs 21 weeks to cross the registry once.
 *
 * UPDATE, never UPSERT. The crawl reads the merged list — database boards plus
 * the ones still in discovered-boards.json — and an upsert would try to INSERT
 * the file-only ones, which carry no `company` (NOT NULL) and, for Workday, no
 * `extra.site` the crawler needs. Silently registering half-formed boards is a
 * worse outcome than not recording a row that isn't in the registry.
 *
 * Batched by shared value rather than issued per board. Every success gets the
 * same three fields, so one statement covers a chunk; failures are grouped by
 * their resulting count, which is a handful of statements rather than 3,400.
 *
 * Deactivation is deliberately slow — a board is retired only after failing
 * several runs in a row, because a single failure is far more often a rate
 * limit than a closed board — and deliberately narrow: the caller must ask for
 * the power with `mayRetire`, and only `boards:verify` does. See the rule beside
 * `counted` below for why the hourly crawl no longer gets a vote.
 */
/** One UPDATE: the boards landing on this failure count, and whether it ends them. */
export interface FailureWrite {
  /** The value `consecutive_failures` is set to. */
  failures: number;
  /** Tokens landing on it, deduplicated. */
  tokens: string[];
  /** Whether this statement also writes `active: false`. */
  retire: boolean;
}

/**
 * Who lands on which failure count, and which of those are ended by it.
 *
 * Pure and exported so the rule can be tested without a database — the same
 * reason `closableBoards` and `mergeBoards` are.
 *
 * Two details that are easy to get wrong and are therefore decided here:
 *
 * - A token absent from `current` is NOT in the registry. It comes from
 *   discovered-boards.json, which the crawl list is merged with, and there is
 *   no row to update. Skipped rather than inserted half-formed.
 * - A token can arrive twice in one batch. A Workday tenant runs a career site
 *   per campus and both rows carry the same token, so two sites failing is two
 *   outcomes for one token. That is ONE strike, not two — deduplicated here
 *   rather than counted twice.
 */
export function planFailureWrites(
  failed: readonly { token: string }[],
  current: ReadonlyMap<string, number>,
  maxFailures: number,
): FailureWrite[] {
  const byNext = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const f of failed) {
    if (!current.has(f.token) || seen.has(f.token)) continue;
    seen.add(f.token);
    const next = (current.get(f.token) ?? 0) + 1;
    const list = byNext.get(next) ?? [];
    list.push(f.token);
    byNext.set(next, list);
  }
  return [...byNext]
    .sort((a, b) => a[0] - b[0])
    .map(([failures, tokens]) => ({ failures, tokens, retire: failures >= maxFailures }));
}

/** Who may end a board's life. */
export interface OutcomeOptions {
  /**
   * Whether the caller is allowed to advance the counter that ends in
   * retirement. Defaults to FALSE, so a caller that does not think about it
   * cannot retire anything — the answer that never costs a live board.
   *
   * Only `boards:verify` passes true. See the rule above recordCrawlOutcomes.
   */
  mayRetire?: boolean;
  /**
   * Injected by tests, the way `fetchImpl` is for the adapters. Defaults to the
   * write client, so production never passes it and cannot pass the wrong one.
   */
  client?: ReturnType<typeof dbWrite>;
}

export async function recordCrawlOutcomes(
  outcomes: {
    provider: string;
    token: string;
    ok: boolean;
    jobs: number;
    error?: string;
    /**
     * Whether the failure says anything about the board. Only 'gone' counts
     * toward retirement; 'refused' — a rate limit, a 5xx, a timeout — is a
     * fact about the vendor's mood and is recorded without penalty.
     */
    failure?: 'gone' | 'refused';
  }[],
  maxFailures: number,
  { mayRetire = false, client: injected }: OutcomeOptions = {},
): Promise<{ recorded: number; deactivated: number; spared: number; looksGone: number }> {
  if (outcomes.length === 0) return { recorded: 0, deactivated: 0, spared: 0, looksGone: 0 };
  const client = injected ?? dbWrite();
  const now = new Date().toISOString();
  let deactivated = 0;
  let recorded = 0;
  let spared = 0;
  let looksGone = 0;

  // Tokens are only unique within a provider, so every statement is scoped by
  // one. Chunked because these become query-string parameters.
  const CHUNK = 200;
  const byProvider = new Map<string, typeof outcomes>();
  for (const o of outcomes) {
    const list = byProvider.get(o.provider) ?? [];
    list.push(o);
    byProvider.set(o.provider, list);
  }

  for (const [provider, list] of byProvider) {
    const ok = list.filter((o) => o.ok).map((o) => o.token);
    for (let i = 0; i < ok.length; i += CHUNK) {
      const { error, count } = await client
        .from('boards')
        .update(
          { last_crawled_at: now, last_ok_at: now, consecutive_failures: 0, last_error: null },
          { count: 'exact' },
        )
        .eq('provider', provider)
        .in('token', ok.slice(i, i + CHUNK));
      if (error) console.error('board outcome write failed:', error.message);
      else recorded += count ?? 0;
    }

    // THE RULE THIS FILE EXISTS FOR.
    //
    // A board that refused us is not a board that is gone. Before this split,
    // `ok: false` covered both, and a vendor rate-limiting us walked live
    // companies to deactivation five strikes at a time: 2,185 of 2,263 retired
    // boards carried an HTTP 429 against 16 that were genuinely 404, and every
    // one sampled afterwards answered 200 with jobs still on it.
    //
    // Refusals get their timestamp and their error text recorded, so the run is
    // still honest about what happened — they simply do not advance the counter
    // that ends in deactivation.
    //
    // AND THE RULE ABOVE IT: only a caller that asked for the power may use it.
    //
    // The split above answers "is this board gone?" from a single hurried look.
    // The hourly crawl takes 25,000 of those looks under vendor rate limits, and
    // it is the pass least able to tell a closure from a bad afternoon. It has
    // been wrong twice: 2,185 boards on a 429, and then 44 more on a Workday
    // challenge page served where JSON belongs, which carries no status code and
    // so matched no refusal rule of the day. Probed live on 8 Sep 2026, 44 of
    // the 81 boards retired for failing answered HTTP 200 with 7,871 jobs.
    //
    // Both of those specific holes are now shut — see the pair of tests in
    // tests/retirement.test.ts that drive the real adapter against an HTML
    // challenge page and against a 404. That is the argument FOR this rule
    // rather than against it: the split is now two-for-two on faults nobody
    // could see in advance, and the third one will be invisible too.
    //
    // So the crawl no longer votes. With mayRetire false every failure — gone or
    // refused — is recorded and none advances the counter, which keeps that
    // counter meaning what it says: consecutive failures seen by the pass that
    // is entitled to retire on them. Feeding it hurried observations would put a
    // board five crawl strikes from death before the careful pass ever looked at
    // it, which is the bug in a new coat.
    //
    // `boards:verify` is that pass: one request per second, a real HTTP status
    // or nothing, and a retry before it calls anything dead.
    const counted = mayRetire ? list.filter((o) => !o.ok && o.failure === 'gone') : [];
    const refused = list.filter((o) => !o.ok && !(mayRetire && o.failure === 'gone'));
    looksGone += list.filter((o) => !o.ok && o.failure === 'gone').length;
    for (let i = 0; i < refused.length; i += CHUNK) {
      const slice = refused.slice(i, i + CHUNK).map((o) => o.token);
      const { error, count } = await client
        .from('boards')
        .update(
          {
            last_crawled_at: now,
            last_error: refused[i]?.error?.slice(0, 300) ?? 'refused',
          },
          { count: 'exact' },
        )
        .eq('provider', provider)
        .in('token', slice);
      if (error) { console.error('board refusal write failed:', error.message); continue; }
      recorded += count ?? 0;
      spared += count ?? 0;
    }

    const failed = counted;
    if (failed.length === 0) continue;

    // Read the current counts first rather than blindly incrementing: PostgREST
    // cannot express `set n = n + 1`, and guessing would let one bad run retire
    // a board that had been healthy until then.
    const current = new Map<string, number>();
    const tokens = failed.map((o) => o.token);
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const { data, error } = await client
        .from('boards')
        .select('token,consecutive_failures')
        .eq('provider', provider)
        .in('token', tokens.slice(i, i + CHUNK));
      if (error) { console.error('board failure read failed:', error.message); continue; }
      for (const r of (data ?? []) as { token: string; consecutive_failures: number }[]) {
        current.set(r.token, r.consecutive_failures ?? 0);
      }
    }

    // Group by the count they land on, so this is a few statements whatever the
    // number of failures. The rule itself is in planFailureWrites, which is pure
    // and tested directly.
    const errorOf = new Map(failed.map((f) => [f.token, f.error ?? 'crawl failed']));
    for (const { failures: next, tokens: group, retire } of planFailureWrites(
      failed,
      current,
      maxFailures,
    )) {
      for (let i = 0; i < group.length; i += CHUNK) {
        const slice = group.slice(i, i + CHUNK);
        const { error, count } = await client
          .from('boards')
          .update(
            {
              last_crawled_at: now,
              consecutive_failures: next,
              // One message for the group. Storing each board's own text would
              // mean a statement per board, and the reason a board is failing
              // is nearly always the same across a batch.
              last_error: errorOf.get(slice[0] as string)?.slice(0, 300) ?? null,
              ...(retire ? { active: false } : {}),
            },
            { count: 'exact' },
          )
          .eq('provider', provider)
          .in('token', slice);
        if (error) { console.error('board failure write failed:', error.message); continue; }
        recorded += count ?? 0;
        if (retire) deactivated += count ?? 0;
      }
    }
  }

  return { recorded, deactivated, spared, looksGone };
}
