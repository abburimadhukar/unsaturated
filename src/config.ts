import 'dotenv/config';

/**
 * Parses a positive integer from the environment.
 *
 * Warns rather than swallowing: `CRAWLER_CONCURRENCY=abc` and `=0` both used to
 * become the default silently, so a typo in a workflow file looked exactly like
 * a correctly configured run.
 */
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`${name}="${raw}" is not a positive integer — using ${fallback}`);
    return fallback;
  }
  return n;
}

export const config = {
  /**
   * Only the legacy Postgres CLIs read this. It is not what the deployed site
   * uses — that is Supabase, configured in src/db/supabase.ts.
   */
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/unsaturated',
  userAgent:
    process.env.CRAWLER_USER_AGENT ?? 'unsaturated-jobscout/0.1 (+mailto:unset@example.com)',
  concurrency: int('CRAWLER_CONCURRENCY', 4),
  delayMs: int('CRAWLER_DELAY_MS', 250),
  timeoutMs: int('CRAWLER_TIMEOUT_MS', 20_000),
  /** A board failing this many runs in a row is deactivated rather than retried forever. */
  maxConsecutiveFailures: int('CRAWLER_MAX_FAILURES', 5),
  /**
   * How long the crawl may spend reading boards before it stops and writes.
   *
   * THE POINT IS THAT A RUN OUT OF TIME STILL WRITES SOMETHING. The crawl
   * workflow is killed at 40 minutes and a killed process writes nothing at
   * all, so on 22 September one shard spent 40 minutes reading boards and
   * stored none of them. It was not stuck: Workable and iCIMS are refused by
   * Cloudflare from Actions runners, the limiter reads a 429 as "slow down" and
   * widens its gap to 4 seconds, and a quarter of Workable at that pace is 61
   * minutes.
   *
   * 30 minutes leaves ten for the writing, the closing pass and the embeddings,
   * which the timeout has to cover too. A lane that runs out stops taking new
   * boards and says how far it got — the WARNING that already prints for an
   * unfinished lane — rather than the whole run being lost silently.
   */
  deadlineMs: int('CRAWLER_DEADLINE_MS', 30 * 60_000),
};
