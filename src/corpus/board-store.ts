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
 * Deactivation is deliberately slow — a board is only retired after failing
 * several runs in a row, because a single failure is far more often a rate limit
 * than a closed board.
 */
export async function recordCrawlOutcomes(
  outcomes: { provider: string; token: string; ok: boolean; jobs: number }[],
  maxFailures: number,
): Promise<{ deactivated: number }> {
  if (outcomes.length === 0) return { deactivated: 0 };
  const client = dbWrite();
  const now = new Date().toISOString();
  let deactivated = 0;

  const ok = outcomes.filter((o) => o.ok);
  const CHUNK = 500;
  for (let i = 0; i < ok.length; i += CHUNK) {
    const chunk = ok.slice(i, i + CHUNK);
    const { error } = await client.from('boards').upsert(
      chunk.map((o) => ({
        provider: o.provider,
        token: o.token,
        last_ok_at: now,
        job_count: o.jobs,
        consecutive_failures: 0,
      })),
      { onConflict: 'provider,token' },
    );
    if (error) console.error('board outcome write failed:', error.message);
  }

  // Failures need the current count, so they are read first rather than blindly
  // incremented.
  const failed = outcomes.filter((o) => !o.ok);
  for (const f of failed) {
    const { data } = await client
      .from('boards')
      .select('consecutive_failures')
      .eq('provider', f.provider)
      .eq('token', f.token)
      .maybeSingle();
    const next = ((data as { consecutive_failures?: number } | null)?.consecutive_failures ?? 0) + 1;
    const retire = next >= maxFailures;
    if (retire) deactivated++;
    await client
      .from('boards')
      .update({ consecutive_failures: next, ...(retire ? { active: false } : {}) })
      .eq('provider', f.provider)
      .eq('token', f.token);
  }

  return { deactivated };
}
