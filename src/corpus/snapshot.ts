import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Feed } from './live.js';

/**
 * Build-time feed snapshot.
 *
 * The deployed site cannot crawl on request: 289 boards take ~30s and every
 * free-tier serverless timeout is at or below that. So the crawl runs during the
 * build, its result is baked into a JSON file, and the site only ever reads it.
 *
 * Refreshing production data therefore means triggering a rebuild — which is a
 * feature, not a workaround: page loads become database-free and instant, and a
 * failed crawl leaves the previous snapshot serving rather than breaking the site.
 *
 * `Feed` is deliberately JSON-safe end to end (dates are ISO strings), so this
 * is a plain write and read with no revival step.
 */

const SNAPSHOT_PATH = resolve(process.cwd(), 'data/feed-snapshot.json');

export async function writeSnapshot(feed: Feed): Promise<string> {
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, JSON.stringify(feed), 'utf8');
  return SNAPSHOT_PATH;
}

export async function loadSnapshot(): Promise<Feed | null> {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    const raw = await readFile(SNAPSHOT_PATH, 'utf8');
    const feed = JSON.parse(raw) as Feed;
    return Array.isArray(feed.jobs) ? feed : null;
  } catch {
    // A corrupt snapshot must not take the site down — fall back to crawling.
    return null;
  }
}

export function snapshotPath(): string {
  return SNAPSHOT_PATH;
}
