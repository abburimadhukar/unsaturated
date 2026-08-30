import { decodeEntities } from '../ats/normalize.js';
import { resolveApplyUrl } from '../ats/resolve.js';
import type { BoardRef } from '../ats/types.js';

/**
 * Harvests ATS boards from Hacker News "Ask HN: Who is hiring?" threads.
 *
 * These run monthly, carry roughly 400 companies each, and — unlike every job
 * aggregator tested — people link straight to their own Greenhouse, Lever or
 * Ashby board. That means exact tokens rather than guesses: one validating
 * request per board instead of the fifteen the name-prober needs.
 *
 * The catch that makes a naive scrape return nothing: HN entity-encodes URLs,
 * writing "/" as "&#x2F;". Comments must be decoded before any URL matching.
 */

const ALGOLIA = 'https://hn.algolia.com/api/v1';

interface AlgoliaStory {
  objectID: string;
  title?: string;
  num_comments?: number;
  created_at?: string;
}

interface AlgoliaItem {
  text?: string | null;
  children?: AlgoliaItem[];
}

export interface HnBoard {
  board: BoardRef;
  /** Thread the link came from, kept for provenance. */
  source: string;
}

async function getJson<T>(url: string, timeoutMs = 25_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'unsaturated-jobscout/0.1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Finds the monthly hiring threads, newest first. */
export async function findHiringThreads(limit = 24): Promise<AlgoliaStory[]> {
  const url =
    `${ALGOLIA}/search_by_date?query=${encodeURIComponent('"Ask HN: Who is hiring"')}` +
    `&tags=story&hitsPerPage=${Math.min(limit * 2, 100)}`;
  const body = await getJson<{ hits?: AlgoliaStory[] }>(url);

  return (body?.hits ?? [])
    // "Who is hiring freelance developers" and "Who wants to be hired" are
    // different threads with a similar title and no employer boards in them.
    .filter((h) => /ask hn:\s*who is hiring\?/i.test(h.title ?? ''))
    .filter((h) => (h.num_comments ?? 0) > 50)
    .slice(0, limit);
}

function collectText(item: AlgoliaItem | null, out: string[]): void {
  if (!item) return;
  if (item.text) out.push(decodeEntities(item.text));
  for (const child of item.children ?? []) collectText(child, out);
}

/**
 * Trailing punctuation and markup routinely cling to URLs pasted into prose.
 * Left in place they become part of the token and every board 404s.
 */
function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]}'"]+$/, '').replace(/<\/?[a-z]+>?$/i, '');
}

export async function harvestThread(story: AlgoliaStory): Promise<HnBoard[]> {
  const item = await getJson<AlgoliaItem>(`${ALGOLIA}/items/${story.objectID}`);
  if (!item) return [];

  const texts: string[] = [];
  collectText(item, texts);

  const seen = new Set<string>();
  const found: HnBoard[] = [];

  for (const url of texts.join(' ').matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const resolved = resolveApplyUrl(cleanUrl(url[0]));
    if (resolved.status !== 'supported') continue;

    const key = `${resolved.board.provider}:${resolved.board.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ board: resolved.board, source: story.title ?? story.objectID });
  }

  return found;
}

export async function harvestHiringThreads(
  months = 24,
  onProgress?: (thread: string, found: number, total: number) => void,
): Promise<HnBoard[]> {
  const threads = await findHiringThreads(months);
  const all = new Map<string, HnBoard>();

  for (const story of threads) {
    const boards = await harvestThread(story);
    for (const b of boards) {
      all.set(`${b.board.provider}:${b.board.token}`, b);
    }
    onProgress?.(story.title ?? story.objectID, boards.length, all.size);
  }

  return [...all.values()];
}
