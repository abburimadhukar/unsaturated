import { PATTERNS, type Pattern, toBoard } from './commoncrawl.js';
import type { AtsProvider } from '../ats/types.js';
import type { OpenBoard } from './opendata.js';

/**
 * The same harvest, against the Internet Archive instead of Common Crawl.
 *
 * WHY A SECOND INDEX AT ALL
 *
 * Common Crawl publishes a snapshot roughly monthly, and on 15 September 2026
 * the newest was still CC-MAIN-2026-34 — late August. The weekly discovery job
 * had therefore been re-reading the same index for five weeks and finding, by
 * construction, nothing. An index that only moves monthly cannot keep a
 * registry current between snapshots, and the gaps are not small.
 *
 * The Internet Archive's CDX index covers the same ground and is written to
 * continuously. Measured 15 September 2026 against captures since 1 June:
 *
 *   greenhouse   3,658 tokens, 525 in no registry, 68% of a sample live
 *   ashby        3,480 tokens, 996 in no registry, 50% of a sample live
 *
 * 10.1 postings per sampled Greenhouse token and 3.5 per Ashby one. That is
 * roughly 850 employers nobody was watching, from one query each.
 *
 * WHAT IT IS NOT GOOD FOR, AND THIS WAS MEASURED TOO
 *
 * Workday and Lever are absent here for the same reason Lever is absent from
 * Common Crawl: their robots.txt excludes archival crawlers. `myworkdayjobs.com`
 * returns 3 rows and `jobs.lever.co` returns 3. Not a bug, not worth retrying,
 * and the reports below say so rather than leaving a zero to be misread as a
 * failure.
 *
 * AND WHAT AN OLD CAPTURE IS WORTH — NOTHING
 *
 * The obvious idea is to reach further back: more history, more tokens. It was
 * tried on Common Crawl's own archive and it is a dead end. Sixty tokens from
 * CC-MAIN-2024-38 that the registry did not hold: three answered, and those
 * three had zero open jobs between them. A board that vanished two years ago is
 * simply gone. Hence `from`, which defaults to recent captures — the window is
 * the filter that makes an archive useful rather than merely large.
 */

const CDX = 'https://web.archive.org/cdx/search/cdx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Common Crawl's pattern syntax is not the Archive's, so it is translated.
 *
 *   CC  'job-boards.greenhouse.io/*'  a host and everything under it
 *   IA  url=job-boards.greenhouse.io&matchType=prefix
 *
 *   CC  '*.recruitee.com/*'           a domain and every subdomain
 *   IA  url=*.recruitee.com
 *
 * BOTH FORMS WERE GOT WRONG ONCE, AND BOTH FAILED QUIETLY
 *
 * The Archive accepts a trailing `*` as shorthand for prefix matching, but
 * combining it with an explicit `matchType=prefix` matches nothing at all:
 * `url=jobs.ashbyhq.com*&matchType=prefix` returns zero rows where
 * `url=jobs.ashbyhq.com&matchType=prefix` returns 37,656. Zero rows is exactly
 * what a robots-excluded host returns, so the bug read as "Ashby is not in the
 * Archive" rather than as a malformed query.
 *
 * `matchType=domain` is not the subdomain form to use either — on a domain of
 * any size it simply times out with a 504. `*.host` does the same job and
 * answers: 8,005 rows for recruitee against the 504.
 */
export function waybackQuery(match: string): { url: string; matchType?: 'prefix' } {
  // The leading '*.' is kept — it is the Archive's own wildcard — and only the
  // trailing '/*', which is Common Crawl's, is dropped.
  const url = match.replace(/\/\*$/, '');
  return url.startsWith('*.') ? { url } : { url, matchType: 'prefix' };
}

/**
 * A floor on `limit`, and it is not politeness that sets it.
 *
 * The Archive applies `limit` to the raw row stream BEFORE `collapse=urlkey`,
 * and the stream is sorted by urlkey — so a small limit reads thousands of
 * near-identical urls from the same handful of boards and collapses them to
 * almost nothing. Measured: limit=4,000 on Ashby yields 7 distinct urls;
 * limit=150,000 yields 37,656.
 *
 * Turning the limit down to be gentle therefore does not read less of the
 * archive, it reads the same start of it and discards the discovery. One large
 * request is both the polite option and the only one that works.
 */
const MIN_LIMIT = 100_000;

/**
 * Patterns the Archive cannot serve, with the reason and the measurement.
 *
 * This is a skip list, not a denial that the boards exist. Common Crawl pages
 * its index by block, so a pattern on an enormous domain is read a block at a
 * time; the Archive has no such thing and must collapse the whole domain in one
 * request. On oraclecloud.com — Oracle's object storage, every IaaS endpoint in
 * every region, every status page — it simply gives up: measured 15 September
 * 2026, a 504 after 61 seconds, three times over.
 *
 * Without this the weekly run spends three or four minutes failing on Oracle
 * before doing anything useful, every week, forever. Oracle is discovered from
 * Common Crawl, where the same pattern works, so nothing is lost.
 *
 * Lever and Workday are deliberately NOT here. They return a handful of rows in
 * twelve seconds, and a cheap confirmation each week that robots.txt still
 * excludes archival crawlers is worth more than an assumption in a comment.
 */
const UNAVAILABLE: Record<string, string> = {
  '*.oraclecloud.com/*':
    'the Archive cannot collapse a domain this large — measured 504 after 61s. ' +
    'Oracle is discovered from Common Crawl, which pages by block.',
};

/** Captures older than this are not worth having — see the header. */
export function defaultFrom(now = new Date()): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - 3);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface WaybackReport {
  provider: AtsProvider;
  pattern: string;
  urls: number;
  tokens: number;
  /** True when the Archive holds nothing for this host, which is usually robots. */
  empty: boolean;
  error?: string;
  /** Why this pattern was not asked for at all — see UNAVAILABLE. */
  skipped?: string;
}

/**
 * One pattern, with patience.
 *
 * The Archive goes down — it answered "Internet Archive: Temporarily Offline"
 * in the middle of this work — and an outage is not evidence that a host has no
 * captures. Anything that is not a parseable row list is reported as an error,
 * never as an empty result, because "empty" is what the caller uses to conclude
 * a vendor is robots-excluded.
 */
async function fetchRows(
  match: string,
  opts: { userAgent: string; from: string; limit: number },
): Promise<string[]> {
  const q = waybackQuery(match);
  const url =
    `${CDX}?url=${encodeURIComponent(q.url)}` +
    (q.matchType ? `&matchType=${q.matchType}` : '') +
    `&output=text&fl=original&collapse=urlkey&filter=statuscode:200` +
    `&from=${opts.from}&limit=${opts.limit}`;

  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(3_000 * 2 ** (attempt - 1));
    let res: Response;
    try {
      // Long, because a large collapse legitimately takes minutes — Greenhouse's
      // 58,250 rows took about 90 seconds. Not unbounded: a domain the Archive
      // cannot serve answers 504 in roughly a minute, and three attempts at
      // four minutes each would eat the workflow's budget rather than the
      // vendor's patience.
      res = await fetch(url, {
        headers: { 'user-agent': opts.userAgent },
        signal: AbortSignal.timeout(240_000),
      });
    } catch {
      continue;
    }
    if (!res.ok) {
      lastStatus = res.status;
      continue;
    }
    const body = await res.text();
    // An outage serves an HTML apology with HTTP 200. A row list never begins
    // with a tag, so this is the difference between "no captures" and "the
    // Archive is down", and treating the second as the first is how a vendor
    // gets written off.
    if (/^\s*</.test(body)) {
      lastStatus = 200;
      continue;
    }
    return body.split('\n').filter((l) => l.trim().length > 0);
  }
  throw new Error(`wayback ${lastStatus || 'unreachable'} after 3 attempts`);
}

/**
 * Board candidates from the Archive, using the SAME patterns and the SAME
 * extraction as the Common Crawl harvest.
 *
 * Deliberately not its own pattern list. Two lists would drift, and the moment
 * they did, one index would be finding a vendor the other silently was not —
 * which is the exact failure the single Common Crawl pattern table was written
 * to avoid. Adding a vendor in one place now adds it to both.
 */
export async function harvestWayback(opts: {
  userAgent: string;
  provider?: AtsProvider;
  /** YYYYMMDD. Defaults to three months back. */
  from?: string;
  /** Rows per pattern, floored at MIN_LIMIT — read the note there before lowering it. */
  limit?: number;
  delayMs?: number;
  onProgress?: (msg: string) => void;
}): Promise<{ boards: OpenBoard[]; reports: WaybackReport[] }> {
  const from = opts.from ?? defaultFrom();
  const limit = Math.max(MIN_LIMIT, opts.limit ?? 150_000);
  const delayMs = opts.delayMs ?? 3_000;
  const seen = new Map<string, OpenBoard>();
  const reports: WaybackReport[] = [];

  const patterns: Pattern[] = opts.provider
    ? PATTERNS.filter((p) => p.provider === opts.provider)
    : PATTERNS;

  for (const p of patterns) {
    const why = UNAVAILABLE[p.match];
    if (why) {
      opts.onProgress?.(`  ${p.match.padEnd(32)} skipped — ${why}`);
      reports.push({ provider: p.provider, pattern: p.match, urls: 0, tokens: 0, empty: false, skipped: why });
      continue;
    }

    const before = seen.size;
    let rows: string[];
    try {
      rows = await fetchRows(p.match, { userAgent: opts.userAgent, from, limit });
    } catch (err) {
      opts.onProgress?.(`  ${p.match.padEnd(32)} unavailable (${String(err)})`);
      reports.push({
        provider: p.provider,
        pattern: p.match,
        urls: 0,
        tokens: 0,
        empty: false,
        error: String(err),
      });
      continue;
    }

    for (const url of rows) {
      const board = toBoard(p, url);
      if (!board) continue;
      const key = `${board.provider}:${board.token.toLowerCase()}:${(board.extra?.site ?? '').toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, board);
    }

    const tokens = seen.size - before;
    reports.push({
      provider: p.provider,
      pattern: p.match,
      urls: rows.length,
      tokens,
      empty: rows.length === 0,
    });
    opts.onProgress?.(
      `  ${p.match.padEnd(32)} ${String(rows.length).padStart(7)} urls -> ${tokens} new` +
        (rows.length === 0 ? '   (no captures — usually robots.txt)' : ''),
    );
    await sleep(delayMs);
  }

  return { boards: [...seen.values()], reports };
}
