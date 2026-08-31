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
};
