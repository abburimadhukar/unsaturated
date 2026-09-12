/**
 * A ceiling on how often one person can spend money.
 *
 * Every tailoring attempt is an OpenAI call. Five people clicking through chips
 * on a handful of jobs is a few pence a month; a page stuck in a render loop is
 * an open tap, and the difference between those two is entirely a matter of rate.
 *
 * PER ISOLATE, NOT GLOBAL — AND THAT IS A REAL LIMITATION
 *
 * Workers gives no shared counter without a Durable Object, so each isolate keeps
 * its own tally and somebody spread across several can exceed the limit by a
 * multiple of however many are warm. Stated plainly rather than implied, because
 * the number below is therefore a guard against runaway loops and NOT a billing
 * guarantee. A limit that sometimes allows a few extra is worth far more than no
 * limit at all while waiting for one that is exact.
 *
 * THE CLOCK IS INJECTED
 *
 * Not for elegance. A sliding window has two off-by-one edges — the attempt
 * exactly at the limit, and the one exactly as the window expires — and neither
 * can be tested at all against a real clock without sleeping for a minute.
 */

/** Attempts allowed per person per window. */
export const PER_WINDOW = 8;

/** The window, in milliseconds. */
export const WINDOW_MS = 60_000;

/** Distinct people tracked before idle entries are swept. */
const MAX_TRACKED = 200;

export interface Limiter {
  /** Records an attempt and says whether it is allowed. */
  allow(userId: string, now?: number): boolean;
  /** How many attempts remain in the current window. For the response header. */
  remaining(userId: string, now?: number): number;
}

export interface LimiterOptions {
  perWindow?: number;
  windowMs?: number;
}

/**
 * A sliding-window limiter over an in-memory map.
 *
 * Sliding rather than fixed buckets: a fixed bucket resetting on the minute lets
 * somebody take the whole allowance at 59 seconds and the whole of the next one at
 * 61, which is double the intended rate at exactly the moment a runaway loop would
 * find it.
 */
export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const perWindow = opts.perWindow ?? PER_WINDOW;
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const seen = new Map<string, number[]>();

  const current = (userId: string, now: number): number[] => {
    const recent = (seen.get(userId) ?? []).filter((t) => now - t < windowMs);
    seen.set(userId, recent);
    return recent;
  };

  const sweep = (now: number): void => {
    if (seen.size <= MAX_TRACKED) return;
    for (const [k, v] of seen) {
      if (v.every((t) => now - t >= windowMs)) seen.delete(k);
    }
  };

  return {
    allow(userId, now = Date.now()) {
      const recent = current(userId, now);
      // >= and not >: at exactly the limit the allowance is already spent, and
      // the off-by-one here is one extra paid call per person per window.
      if (recent.length >= perWindow) return false;
      recent.push(now);
      seen.set(userId, recent);
      sweep(now);
      return true;
    },
    remaining(userId, now = Date.now()) {
      return Math.max(0, perWindow - current(userId, now).length);
    },
  };
}

const SHARED_KEY = Symbol.for('unsaturated.tailor.limiter');

/**
 * The limiter the route uses.
 *
 * On globalThis so it survives module re-evaluation within an isolate, which is
 * the same trick the profile cache uses and for the same reason — without it a
 * bundler or a hot path that re-imports resets the tally to empty.
 */
export function sharedLimiter(): Limiter {
  const g = globalThis as unknown as Record<symbol, Limiter | undefined>;
  g[SHARED_KEY] ??= createLimiter();
  return g[SHARED_KEY]!;
}
