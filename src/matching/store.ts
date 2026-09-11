import { dbWrite } from '../db/supabase.js';
import { toVectorLiteral } from './embed.js';
import type { Stored } from './plan.js';

/**
 * Reading and writing the map.
 *
 * Thin on purpose. The decisions live in plan.ts, which is pure and tested
 * without a database; this file only moves rows. What it does carry is the two
 * things that are easy to get wrong against PostgREST.
 *
 * KEYS TRAVEL IN THE URL
 *
 * A job key looks like `greenhouse:acme:8161813`, around 30 characters, and
 * asking about them uses `in.(...)` in a query string. db-feed.ts already ran
 * into this and settled on 150 per statement for exactly the same reason, so
 * that number is copied rather than re-derived.
 *
 * A VECTOR IS NOT A JSON ARRAY
 *
 * halfvec will not accept one. Sent as the bracketed literal pgvector parses,
 * which is what toVectorLiteral produces — see its note on why there are no
 * spaces in it.
 */

/** Matches db-feed.ts's FILTER_CHUNK. Same constraint, same answer. */
const KEY_CHUNK = 150;

/** Rows written per statement. These travel in the body, so the limit is size. */
const WRITE_CHUNK = 100;

/** The client shape these need, so a test can pass a fake. */
export interface MatchClient {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => Promise<{
        data: { job_key: string; source_hash: string; model: string }[] | null;
        error: { message: string } | null;
      }>;
    };
    upsert: (
      rows: Record<string, unknown>[],
      options: { onConflict: string },
    ) => Promise<{ error: { message: string } | null; count: number | null }>;
  };
}

export interface StoreOptions {
  client?: MatchClient;
}

/**
 * What the database already holds for these jobs.
 *
 * A missing key is the answer "never embedded", not an error — on the first run
 * every key is missing, which is the normal case rather than the exception.
 *
 * A read failure returns what it managed to collect rather than throwing. Losing
 * a chunk means some jobs look unembedded and get embedded again: wasteful, and
 * the cheapest possible wrong answer. Throwing would fail a crawl that has
 * already written its postings correctly, which is the expensive one.
 */
export async function readStoredHashes(
  keys: readonly string[],
  opts: StoreOptions = {},
): Promise<Map<string, Stored>> {
  const out = new Map<string, Stored>();
  if (keys.length === 0) return out;
  const client = opts.client ?? (dbWrite() as unknown as MatchClient);

  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const slice = keys.slice(i, i + KEY_CHUNK);
    const { data, error } = await client
      .from('job_embedding')
      .select('job_key,source_hash,model')
      .in('job_key', [...slice]);

    if (error) {
      console.error(`embedding hash read failed for ${slice.length} keys:`, error.message);
      continue;
    }
    for (const row of data ?? []) {
      out.set(row.job_key, { hash: row.source_hash, model: row.model });
    }
  }
  return out;
}

export interface EmbeddingRow {
  jobKey: string;
  vector: readonly number[];
  model: string;
  sourceHash: string;
}

/**
 * Stores vectors, replacing any the jobs already had.
 *
 * Upsert rather than insert. A re-embed — a changed advert, or a new model — has
 * to overwrite, and a crawl that raced itself must not fail on a duplicate key.
 *
 * Returns how many rows were written. A failed chunk is logged and skipped
 * rather than thrown, for the same reason as the read: the postings are already
 * saved by this point, and a missing vector costs one job its score until the
 * next run, while a thrown error costs the whole run.
 */
export async function writeEmbeddings(
  rows: readonly EmbeddingRow[],
  opts: StoreOptions = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const client = opts.client ?? (dbWrite() as unknown as MatchClient);

  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK).map((r) => ({
      job_key: r.jobKey,
      embedding: toVectorLiteral(r.vector),
      model: r.model,
      source_hash: r.sourceHash,
    }));

    const { error, count } = await client
      .from('job_embedding')
      .upsert(chunk, { onConflict: 'job_key' });

    if (error) {
      console.error(`embedding write failed for ${chunk.length} rows:`, error.message);
      continue;
    }
    // PostgREST only returns a count when asked for one, and this call does not
    // ask: counting costs a second pass over the rows to learn a number that is
    // already known. A successful chunk wrote all of it.
    written += count ?? chunk.length;
  }
  return written;
}
