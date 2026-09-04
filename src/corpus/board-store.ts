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
  const byKey = new Map<string, StoredBoard>();
  for (const b of boards) byKey.set(`${b.provider}:${b.token}`, b);

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
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error, count } = await client
      .from('boards')
      .upsert(chunk, { onConflict: 'provider,token', count: 'exact' });
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
 * limit than a closed board.
 */
export async function recordCrawlOutcomes(
  outcomes: { provider: string; token: string; ok: boolean; jobs: number; error?: string }[],
  maxFailures: number,
): Promise<{ recorded: number; deactivated: number }> {
  if (outcomes.length === 0) return { recorded: 0, deactivated: 0 };
  const client = dbWrite();
  const now = new Date().toISOString();
  let deactivated = 0;
  let recorded = 0;

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

    const failed = list.filter((o) => !o.ok);
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
    // number of failures.
    const byNext = new Map<number, string[]>();
    for (const f of failed) {
      // Absent from the map means the board is not in the registry — a
      // file-only board. Nothing to update.
      if (!current.has(f.token)) continue;
      const next = (current.get(f.token) ?? 0) + 1;
      const list2 = byNext.get(next) ?? [];
      list2.push(f.token);
      byNext.set(next, list2);
    }

    const errorOf = new Map(failed.map((f) => [f.token, f.error ?? 'crawl failed']));
    for (const [next, group] of byNext) {
      const retire = next >= maxFailures;
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

  return { recorded, deactivated };
}
