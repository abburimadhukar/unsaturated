import 'dotenv/config';

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/unsaturated',
  userAgent:
    process.env.CRAWLER_USER_AGENT ?? 'unsaturated-jobscout/0.1 (+mailto:unset@example.com)',
  concurrency: int(process.env.CRAWLER_CONCURRENCY, 4),
  delayMs: int(process.env.CRAWLER_DELAY_MS, 250),
  timeoutMs: int(process.env.CRAWLER_TIMEOUT_MS, 20_000),
  /** A board failing this many runs in a row is deactivated rather than retried forever. */
  maxConsecutiveFailures: int(process.env.CRAWLER_MAX_FAILURES, 5),
};
