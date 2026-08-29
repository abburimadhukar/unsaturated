import type pg from 'pg';
import { getAdapter } from '../ats/adapters/index.js';
import { AtsFetchError, type AtsProvider, type BoardRef, type NormalizedJob } from '../ats/types.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db/client.js';
import { contentHash, identityHash } from './hash.js';

export interface CrawlStats {
  boardsTotal: number;
  boardsOk: number;
  boardsFailed: number;
  jobsNew: number;
  jobsUpdated: number;
  jobsClosed: number;
  repostsFound: number;
  errors: { provider: string; token: string; message: string }[];
}

interface BoardRow {
  id: string;
  provider: AtsProvider;
  token: string;
  extra: Record<string, string> | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Persists one board's worth of postings.
 *
 * Runs in a single transaction so a mid-board failure cannot leave half the
 * board marked closed. Returns per-board deltas for the run summary.
 */
async function persistBoard(
  board: BoardRow,
  jobs: NormalizedJob[],
): Promise<{ jobsNew: number; jobsUpdated: number; jobsClosed: number; repostsFound: number }> {
  return withTransaction(async (client) => {
    let jobsNew = 0;
    let jobsUpdated = 0;
    let repostsFound = 0;
    const seenExternalIds: string[] = [];

    for (const job of jobs) {
      const cHash = contentHash(job);
      const iHash = identityHash(board.id, job);
      seenExternalIds.push(job.externalId);

      const existing = await client.query<{ id: string; content_hash: string; closed_at: Date | null }>(
        `SELECT id, content_hash, closed_at FROM jobs WHERE board_id = $1 AND external_id = $2`,
        [board.id, job.externalId],
      );

      if (existing.rowCount && existing.rows[0]) {
        const row = existing.rows[0];
        const changed = row.content_hash !== cHash;
        await client.query(
          `UPDATE jobs SET
             title = $2, description_text = $3, description_html = $4,
             location_raw = $5, country = $6, region = $7, city = $8,
             remote_type = $9, employment_type = $10, department = $11, team = $12,
             seniority = $13, salary_min = $14, salary_max = $15, salary_currency = $16,
             apply_url = $17, listing_url = $18, posted_at = COALESCE($19, jobs.posted_at),
             content_hash = $20, identity_hash = $21, raw = $22,
             last_seen_at = now(), closed_at = NULL,
             updated_at = CASE WHEN $23 THEN now() ELSE jobs.updated_at END
           WHERE id = $1`,
          [
            row.id, job.title, job.descriptionText ?? null, job.descriptionHtml ?? null,
            job.locationRaw ?? null, job.country ?? null, job.region ?? null, job.city ?? null,
            job.remoteType ?? null, job.employmentType ?? null, job.department ?? null, job.team ?? null,
            job.seniority ?? null, job.salaryMin ?? null, job.salaryMax ?? null, job.salaryCurrency ?? null,
            job.applyUrl ?? null, job.listingUrl ?? null, job.postedAt ?? null,
            cHash, iHash, JSON.stringify(job.raw), changed,
          ],
        );
        if (changed) jobsUpdated++;
        continue;
      }

      // New external_id. Before inserting, check whether this same role was
      // previously listed and closed on this board — that is a repost, and the
      // ghost-job classifier in Phase 2 reads these events.
      const prior = await client.query<{ id: string; closed_at: Date | null }>(
        `SELECT id, closed_at FROM jobs
          WHERE board_id = $1 AND identity_hash = $2 AND closed_at IS NOT NULL
          ORDER BY closed_at DESC LIMIT 1`,
        [board.id, iHash],
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO jobs (
           board_id, external_id, title, description_text, description_html,
           location_raw, country, region, city, remote_type, employment_type,
           department, team, seniority, salary_min, salary_max, salary_currency,
           apply_url, listing_url, posted_at, content_hash, identity_hash, raw
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
         )
         ON CONFLICT (board_id, external_id) DO NOTHING
         RETURNING id`,
        [
          board.id, job.externalId, job.title, job.descriptionText ?? null, job.descriptionHtml ?? null,
          job.locationRaw ?? null, job.country ?? null, job.region ?? null, job.city ?? null,
          job.remoteType ?? null, job.employmentType ?? null, job.department ?? null, job.team ?? null,
          job.seniority ?? null, job.salaryMin ?? null, job.salaryMax ?? null, job.salaryCurrency ?? null,
          job.applyUrl ?? null, job.listingUrl ?? null, job.postedAt ?? null,
          cHash, iHash, JSON.stringify(job.raw),
        ],
      );

      const newId = inserted.rows[0]?.id;
      if (!newId) continue;
      jobsNew++;

      const priorRow = prior.rows[0];
      if (priorRow?.closed_at) {
        const gapDays = (Date.now() - priorRow.closed_at.getTime()) / 86_400_000;
        await client.query(
          `INSERT INTO job_repost_events (identity_hash, board_id, previous_job_id, new_job_id, gap_days)
           VALUES ($1, $2, $3, $4, $5)`,
          [iHash, board.id, priorRow.id, newId, gapDays.toFixed(2)],
        );
        repostsFound++;
      }
    }

    // Anything on this board that did not appear in the feed is now closed.
    //
    // Guard: an empty feed is treated as a transient vendor blip, not as "the
    // company deleted every job". Without this, one bad response would wipe a
    // board's entire history and destroy the posting-age signal permanently.
    let jobsClosed = 0;
    if (seenExternalIds.length > 0) {
      const closed = await client.query(
        `UPDATE jobs SET closed_at = now(), updated_at = now()
          WHERE board_id = $1 AND closed_at IS NULL AND NOT (external_id = ANY($2::text[]))`,
        [board.id, seenExternalIds],
      );
      jobsClosed = closed.rowCount ?? 0;
    }

    return { jobsNew, jobsUpdated, jobsClosed, repostsFound };
  });
}

async function crawlBoard(board: BoardRow, stats: CrawlStats): Promise<void> {
  const adapter = getAdapter(board.provider);
  try {
    const ref: BoardRef = { provider: board.provider, token: board.token };
    if (board.extra) ref.extra = board.extra;

    const jobs = await adapter.fetchJobs(ref, {
      userAgent: config.userAgent,
      timeoutMs: config.timeoutMs,
    });

    const delta = await persistBoard(board, jobs);
    stats.jobsNew += delta.jobsNew;
    stats.jobsUpdated += delta.jobsUpdated;
    stats.jobsClosed += delta.jobsClosed;
    stats.repostsFound += delta.repostsFound;
    stats.boardsOk++;

    await query(
      `UPDATE boards SET last_crawled_at = now(), last_success_at = now(),
              consecutive_failures = 0, last_error = NULL
        WHERE id = $1`,
      [board.id],
    );
  } catch (err) {
    stats.boardsFailed++;
    const message = err instanceof Error ? err.message : String(err);
    stats.errors.push({ provider: board.provider, token: board.token, message });

    // A 404 means a wrong token and will never recover; deactivate immediately
    // rather than burning the retry budget on it every run.
    const permanent = err instanceof AtsFetchError && err.status === 404;
    await query(
      `UPDATE boards SET last_crawled_at = now(),
              consecutive_failures = consecutive_failures + 1,
              last_error = $2,
              active = CASE WHEN $3 OR consecutive_failures + 1 >= $4 THEN false ELSE active END
        WHERE id = $1`,
      [board.id, message, permanent, config.maxConsecutiveFailures],
    );
  }
}

/** Fixed-size worker pool; ATS vendors rate-limit per IP so this stays low. */
async function pooled<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item === undefined) break;
      await worker(item);
      if (config.delayMs > 0) await sleep(config.delayMs);
    }
  });
  await Promise.all(runners);
}

export async function runCrawl(options: { limit?: number } = {}): Promise<CrawlStats> {
  const limit = options.limit ?? 500;
  const boards = await query<BoardRow>(
    `SELECT id, provider, token, extra FROM boards
      WHERE active = true
      ORDER BY last_crawled_at NULLS FIRST
      LIMIT $1`,
    [limit],
  );

  const stats: CrawlStats = {
    boardsTotal: boards.rowCount ?? 0,
    boardsOk: 0,
    boardsFailed: 0,
    jobsNew: 0,
    jobsUpdated: 0,
    jobsClosed: 0,
    repostsFound: 0,
    errors: [],
  };

  const run = await query<{ id: string }>(
    `INSERT INTO crawl_runs (boards_total) VALUES ($1) RETURNING id`,
    [stats.boardsTotal],
  );
  const runId = run.rows[0]?.id;

  await pooled(boards.rows, config.concurrency, (board) => crawlBoard(board, stats));

  if (runId) {
    await query(
      `UPDATE crawl_runs SET finished_at = now(), boards_ok = $2, boards_failed = $3,
              jobs_new = $4, jobs_updated = $5, jobs_closed = $6, reposts_found = $7
        WHERE id = $1`,
      [runId, stats.boardsOk, stats.boardsFailed, stats.jobsNew, stats.jobsUpdated, stats.jobsClosed, stats.repostsFound],
    );
  }

  return stats;
}

/** Registers a board token discovered by the resolver. Idempotent. */
export async function upsertBoard(
  ref: BoardRef,
  discoveredVia = 'apply_url',
  client?: pg.PoolClient,
): Promise<string | undefined> {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO boards (provider, token, extra, discovered_via)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, token) DO UPDATE SET active = true
     RETURNING id`,
    [ref.provider, ref.token, JSON.stringify(ref.extra ?? {}), discoveredVia],
  );
  return (res.rows[0] as { id: string } | undefined)?.id;
}
