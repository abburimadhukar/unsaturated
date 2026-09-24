import { dbWrite } from '../db/supabase.js';
import { upsertInChunks } from './db-feed.js';
import type { FeedJob } from './types.js';

/**
 * What the crawl threw away, kept as counts rather than rows.
 *
 * Every hour the crawl reads ~240,000 postings and keeps ~16,000. The other
 * 224,000 were discarded with no record at all, which made two very different
 * outcomes look identical: a Registered Nurse correctly rejected, and a Cloud
 * Operations Engineer rejected by a rule with a bug in it.
 *
 * That is not hypothetical. Sampling 120 boards by hand turned up four rules
 * that matched nothing — a word-boundary error meant `systems? admin` could
 * never match "Systems Administrator"; "Solutions Architect" only counted with
 * "cloud" in front of it; "Applications Engineer" only matched the plural; and
 * Forward Deployed Engineer and AI Engineer, ~170 live postings, matched no rule
 * at all. Finding those took an afternoon and covered 1% of the registry.
 *
 * Counts, not rows, because 224,000 rows an hour is not worth storing and not
 * worth reading. Aggregating in memory first turns a crawl into a few thousand
 * upserts of the form "rule X rejected 340 things called Cloud Operations
 * Engineer", which is the shape the question is actually asked in.
 */

/**
 * Distinct (reason, title) pairs written per run, highest count first.
 *
 * Started at 3,000 and that turned out to cut the thing the table is for. One
 * crawl discarded 232,366 postings; the cap stored the top 3,000 pairs per
 * shard and captured about 99,000 of them, so the common titles were all
 * present and every rare one was gone. "Are we commonly missing something?" was
 * answerable and "did we lose THIS role?" was not — and the second is the
 * question that finds a broken rule, because a rule with a bug in it usually
 * drops an uncommon title.
 *
 * 25,000 covers a shard's whole distinct set with room to spare. The cost is a
 * larger payload, not more round trips: the write is one set-based statement
 * per chunk, and the table converges on the distinct set rather than growing
 * with volume.
 */
const TOP_N = Number.parseInt(process.env.EXCLUSION_TOP_N ?? '25000', 10);

/**
 * Rows per RPC call.
 *
 * The whole tally in one call would be a multi-megabyte JSON body. Chunking
 * keeps each request small while still being a handful of statements rather
 * than one per title.
 *
 * 1,000, down from 5,000. At 5,000 this averaged 2,349ms and peaked at 7,954ms
 * against an 8-second limit — the slowest query in the database, and one that
 * lost its results every time it crossed the line. The halving retry below now
 * catches what does cross it; starting lower means it rarely has to.
 */
const WRITE_CHUNK = 1000;

/**
 * Titles are collapsed so trivially different postings land on one row.
 *
 * Deliberately conservative: lowercase, strip the noise employers append, and
 * squeeze whitespace. Nothing that changes which words are present, because the
 * whole point is to read the words back.
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    // Requisition ids and location suffixes in brackets: "(Remote)", "[REQ-123]".
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    // Trailing " - Chicago, IL" style qualifiers after the last dash.
    .replace(/\s+[-–—]\s+[^-–—]{1,40}$/, '')
    .replace(/[^a-z0-9+#/&. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export interface ExclusionCount {
  reason: string;
  title: string;
  n: number;
  sampleCompany: string;
}

/**
 * Folds a crawl's discarded postings into counts.
 *
 * Takes the full scanned set — in-scope rows are skipped here rather than by the
 * caller, so this cannot be handed an already-filtered list by mistake and
 * silently report nothing.
 */
export function tallyExclusions(jobs: FeedJob[], topN = TOP_N): ExclusionCount[] {
  const counts = new Map<string, ExclusionCount>();
  for (const job of jobs) {
    if (job.inScope) continue;
    const reason = job.excludedReason ?? 'no family matched';
    const title = normaliseTitle(job.title);
    if (!title) continue;
    // A NUL separator, written as an escape so it is visible in the source.
    // A space would collide: "no family matched" contains spaces, so
    // reason+" "+title could be split two ways and two different pairs
    // could produce the same key.
    const key = `${reason}\u0000${title}`;
    const existing = counts.get(key);
    if (existing) existing.n++;
    else counts.set(key, { reason, title, n: 1, sampleCompany: job.company });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, topN);
}

/**
 * Adds a crawl's tally to the running totals.
 *
 * Never fatal. This is instrumentation: a crawl that read and stored jobs
 * correctly must not be failed because the bookkeeping table is missing or the
 * migration has not been applied yet.
 */
export async function recordExclusions(rows: ExclusionCount[]): Promise<number> {
  if (rows.length === 0) return 0;
  const client = dbWrite();
  try {
    // Halved on a timeout, like every other write in this project.
    //
    // This was the one path that had no such retry: a 5,000-row chunk that ran
    // out of time was logged and SKIPPED, so its counts were simply lost. On
    // 24 Sep every chunk of every shard was skipped that way and the tally
    // recorded nothing at all, while `record_exclusions` remained 12% of all
    // database time at a 2,349ms mean and a 7,954ms worst case — against an
    // 8-second limit. It was the most expensive query in the database AND the
    // one throwing its own results away.
    //
    // upsertInChunks is the helper the jobs upsert uses. It halves on exactly
    // the transient errors this was swallowing, and it never skips: a chunk is
    // either written or it throws — which the catch below turns back into the
    // "never fatal" behaviour instrumentation is supposed to have.
    return await upsertInChunks(
      rows,
      async (chunk) => {
        const { data, error } = await client.rpc('record_exclusions', {
          p_rows: chunk.map((r) => ({
            reason: r.reason,
            title: r.title,
            n: r.n,
            sample_company: r.sampleCompany,
          })),
        });
        return { error, count: (data as number | null) ?? chunk.length };
      },
      {
        chunk: WRITE_CHUNK,
        onRetry: (size, next, message) =>
          console.warn(`  exclusion chunk of ${size} timed out, retrying ${next} — ${message}`),
      },
    );
  } catch (err) {
    // Never fatal. A crawl that read and stored jobs correctly must not be
    // failed because the bookkeeping table is missing or slow.
    console.error('exclusion tally not recorded:', err instanceof Error ? err.message : err);
    return 0;
  }
}
