import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AtsProvider } from '../ats/types.js';

export interface CorpusBoard {
  provider: AtsProvider;
  token: string;
  company: string;
  /** Workday carries host + site here; other providers need nothing. */
  extra?: Record<string, string>;
  /** Caps pagination so one enterprise board can't dominate a refresh. */
  maxJobs?: number;
}

/**
 * The seven boards the adapters were originally smoke-tested against. These are
 * test fixtures — three of them are the ATS vendors' own job boards — and exist
 * only so the app still runs before discovery has been run.
 */
const FALLBACK: CorpusBoard[] = [
  { provider: 'lever', token: 'lyrahealth', company: 'Lyra Health' },
  { provider: 'ashby', token: 'ashby', company: 'Ashby' },
  { provider: 'greenhouse', token: 'gruve', company: 'Gruve' },
];

const DEFAULT_MAX_JOBS = 300;

/**
 * The board list: the file and the database, merged.
 *
 * Merged rather than "database, or else the file", because that version had a
 * trap. readActiveBoards returns rows whenever the table is non-empty, so a
 * partially seeded registry — say 300 rows imported during a test — would have
 * replaced the 1,437 boards in the file rather than adding to them, and coverage
 * would silently shrink to a fifth.
 *
 * Merging makes seeding additive and interruptible: import any number of rows,
 * at any time, and the crawl only ever gains boards. The database wins on
 * conflict, since it carries verification state the file does not.
 */
/**
 * The crawl list: the seed file and the registry, as one set of boards.
 *
 * KEYED CASE-INSENSITIVELY, because these APIs are and the two sources disagree.
 *
 * The file holds `vultr`, the registry holds `Vultr`, and a case-sensitive key
 * kept both — so the crawler fetched one board twice under two names. A job key
 * is provider:token:id, so both copies stored the SAME posting under different
 * keys and both reached the site. Measured 7 Sep 2026: Snowflake listed twice
 * with 81 jobs each, Canva twice with 44, TogetherAI twice with 10, across 89
 * such pairs.
 *
 * boards-dedupe could never catch this one. It compares rows in the `boards`
 * table, and the duplicate half was never a row — it came from the file.
 *
 * The database entry is applied second and therefore wins, which is what we
 * want: it is the copy carrying verification, health and retirement.
 *
 * Pure and exported so the rule can be tested without a database.
 */
export function mergeBoards(fromFile: CorpusBoard[], fromDb: CorpusBoard[]): Map<string, CorpusBoard> {
  // The Workday site is part of the key, or this collapses the very boards the
  // registry now exists to hold. A tenant runs a career site per campus —
  // nshe/GBC-external and nshe/UNR-external share no job ids — and folding them
  // to one entry here would mean the crawler only ever fetched one of them,
  // making the whole multi-site registry pointless.
  const key = (b: { provider: string; token: string; extra?: Record<string, string> }) =>
    `${b.provider}:${b.token.toLowerCase()}:${(b.extra?.site ?? '').toLowerCase()}`;
  const merged = new Map<string, CorpusBoard>();
  for (const b of fromFile) merged.set(key(b), b);
  for (const b of fromDb) merged.set(key(b), { ...b, maxJobs: b.maxJobs ?? DEFAULT_MAX_JOBS });
  return merged;
}

export async function loadBoardsAsync(): Promise<CorpusBoard[]> {
  const fromFile = loadBoards();

  let fromDb: CorpusBoard[] | null = null;
  try {
    const { readActiveBoards } = await import('./board-store.js');
    fromDb = await readActiveBoards();
  } catch (err) {
    console.error('board registry unavailable, using the file alone:', err);
  }
  if (!fromDb || fromDb.length === 0) return fromFile;

  const merged = mergeBoards(fromFile, fromDb);

  // Applied after the merge, not before. Deactivating a board in the database is
  // not enough on its own: the file is merged in too, so a blocked board that
  // also appears there would keep being crawled. Filtering the combined list is
  // the only place that catches both.
  try {
    const { loadBlocklist, blockKey } = await import('./blocklist.js');
    const blocked = await loadBlocklist();
    if (blocked.size > 0) {
      // blockKey folds case as well, so both sides of this comparison agree.
      for (const k of merged.keys()) if (blocked.has(k)) merged.delete(k);
    }
  } catch (err) {
    // An unreadable blocklist must not stop the crawl.
    console.error('blocklist not applied:', err);
  }

  return [...merged.values()];
}

/**
 * Loads boards found by `npm run discover`. Falling back to fixtures keeps a
 * clean checkout working, but the real corpus is whatever discovery produced.
 */
export function loadBoards(): CorpusBoard[] {
  const path = resolve(process.cwd(), 'discovered-boards.json');
  if (!existsSync(path)) return FALLBACK;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CorpusBoard[];
    if (!Array.isArray(parsed) || parsed.length === 0) return FALLBACK;

    // Different company names can resolve to the same tenant — "Cloudflare" and
    // "Cloudflare Area 1" both slug to `cloudflare` — which would otherwise
    // crawl the same board twice and duplicate every one of its jobs.
    const seen = new Map<string, CorpusBoard>();
    for (const b of parsed) {
      const key = `${b.provider}:${b.token}`;
      const existing = seen.get(key);
      // Keep the shorter company name; it is nearly always the canonical one.
      if (!existing || b.company.length < existing.company.length) {
        seen.set(key, { ...b, maxJobs: b.maxJobs ?? DEFAULT_MAX_JOBS });
      }
    }
    return [...seen.values()];
  } catch {
    return FALLBACK;
  }
}
