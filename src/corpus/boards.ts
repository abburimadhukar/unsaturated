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
 * The board list, preferring the database.
 *
 * The registry moved into Supabase because a JSON file cannot hold 15,000+
 * boards usefully — see corpus/board-store.ts. The file remains the fallback so
 * a clean checkout, a local run with no credentials, and a database outage all
 * still crawl something rather than nothing.
 */
export async function loadBoardsAsync(): Promise<CorpusBoard[]> {
  try {
    const { readActiveBoards } = await import('./board-store.js');
    const fromDb = await readActiveBoards();
    if (fromDb && fromDb.length > 0) {
      const withCaps = fromDb.map((b) => ({ ...b, maxJobs: b.maxJobs ?? DEFAULT_MAX_JOBS }));
      return withCaps;
    }
  } catch (err) {
    console.error('board registry unavailable, using the file:', err);
  }
  return loadBoards();
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
