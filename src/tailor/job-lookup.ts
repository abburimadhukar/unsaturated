import { dbWrite } from '../db/supabase.js';

/**
 * Finding the job a tailoring request is about.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN TWICE
 *
 * It was written twice, and the second copy asked `jobs` for a column that lives
 * on `boards`. Postgres returned an error, the caller turned that into `null`,
 * and the person was told "that job is not in the feed any more" — about a job
 * whose title and company were on the screen in front of them. Every job, every
 * time.
 *
 * Two separate faults, and the second is the worse one:
 *
 *   1. The query was wrong. `company` is on jobs; `extra` is not.
 *   2. A DATABASE ERROR WAS REPORTED AS A MISSING ROW. Those are different
 *      things and must never share a message — one means "this posting has gone",
 *      which is a fact about the world, and the other means "we are broken",
 *      which is a fact about us. Reporting the second as the first sends somebody
 *      looking for a job that is right there.
 *
 * So the lookup lives in one place, it distinguishes the two outcomes, and there
 * is a test asserting that every column it names exists in schema.sql.
 *
 * THE WORKDAY READ, AND WHY IT IS CONDITIONAL
 *
 * A Workday address is {tenant}.{shard}.myworkdayjobs.com/{site}, and neither
 * half is in the job key — they are on the board row. Only Workday needs it and
 * only Workday has several boards per token, so the second read happens for
 * Workday and nothing else. A join on (provider, token) would silently pick one
 * of an employer's several portals.
 */

/** Exactly the columns that exist on `jobs`. Asserted against schema.sql by a test. */
export const JOB_COLUMNS = 'key,title,company,provider,board_token,apply_url,closed_at' as const;

export interface JobRow {
  key: string;
  title: string;
  company: string;
  provider: string;
  board_token: string;
  apply_url: string | null;
  closed_at: string | null;
}

export type JobLookup =
  | { ok: true; job: JobRow; extra: Record<string, string> | undefined }
  /** The row is genuinely not there. A fact about the world. */
  | { ok: false; found: false; reason: string }
  /** We could not ask. A fact about us, and it must not read like the above. */
  | { ok: false; found: true; reason: string };

export interface LookupOptions {
  /** Injected in tests; never set in production. */
  client?: ReturnType<typeof dbWrite>;
}

export async function loadJobForTailoring(
  jobKey: string,
  opts: LookupOptions = {},
): Promise<JobLookup> {
  const client = opts.client ?? dbWrite();

  let job: JobRow | null = null;
  try {
    const { data, error } = await client
      .from('jobs')
      .select(JOB_COLUMNS)
      .eq('key', jobKey)
      .maybeSingle();
    if (error) {
      // Said plainly, with the database's own words. A swallowed error here is
      // what produced "that job is not in the feed any more" for every job on
      // the site, and nothing in the logs said otherwise.
      return {
        ok: false,
        found: true,
        reason: `could not read that job from the database: ${error.message ?? 'unknown error'}`,
      };
    }
    job = (data as JobRow | null) ?? null;
  } catch (err) {
    return {
      ok: false,
      found: true,
      reason: `could not reach the database: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  if (!job) {
    return { ok: false, found: false, reason: 'that job is not in the feed any more' };
  }

  if (job.provider !== 'workday') return { ok: true, job, extra: undefined };

  try {
    const { data: boards } = await client
      .from('boards')
      .select('extra')
      .eq('provider', job.provider)
      .eq('token', job.board_token);
    for (const b of (boards ?? []) as { extra: Record<string, string> | null }[]) {
      if (b.extra?.host && b.extra?.site) return { ok: true, job, extra: b.extra };
    }
  } catch {
    // A missing address is reported by describeJob as "this board is missing the
    // address we need", which is the accurate message. Failing the whole lookup
    // here would be worse than letting it say so.
  }
  return { ok: true, job, extra: undefined };
}
