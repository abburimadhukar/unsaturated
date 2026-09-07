import type { AtsProvider } from '../ats/types.js';

/**
 * How fast we may poll each vendor, learned during the run.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The crawler had one global concurrency and one fixed delay for every vendor.
 * Greenhouse will happily serve thousands of requests a minute; Workable's
 * widget API will not, and says so with HTTP 429. A single global setting can
 * only be tuned for the slowest vendor — starving the fast ones — or the
 * fastest, which is what we had, and which buried Workable.
 *
 * The damage was not theoretical. 90% of Workable boards were failing, and
 * because the crawler could not tell a refusal from a death, 2,157 live
 * companies were retired for it.
 *
 * HOW IT WORKS
 *
 * Additive increase, multiplicative decrease — the same shape as TCP congestion
 * control, for the same reason: nobody publishes their rate limit, so the only
 * way to find it is to approach it gently and retreat fast.
 *
 *   refused  → halve the concurrency, double the gap. Immediately.
 *   settled  → after a run of clean responses, add one worker back and ease
 *              the gap down a little.
 *
 * Retreat is instant and recovery is slow, which is the right asymmetry: the
 * cost of being slightly too slow is a board read next hour instead of this
 * one, and the cost of being too fast is what happened this afternoon.
 *
 * State lives for one run. A crawl makes tens of thousands of requests, so a
 * vendor's real limit is found within the first few hundred and holds for the
 * rest — and starting fresh each hour means a vendor that has loosened its
 * limits is never held to yesterday's guess.
 */

export interface LimiterOptions {
  /** Workers a provider may hold at once before anything is learned. */
  startConcurrency?: number;
  /** Never drop below this, or a slow vendor would stall the whole run. */
  minConcurrency?: number;
  maxConcurrency?: number;
  /** Minimum gap between two requests to the same provider, milliseconds. */
  startGapMs?: number;
  maxGapMs?: number;
  /** Clean responses needed before easing back up. */
  recoverAfter?: number;
}

interface ProviderState {
  concurrency: number;
  gapMs: number;
  inFlight: number;
  nextFreeAt: number;
  cleanRun: number;
  refusals: number;
  /** Set when a vendor sent Retry-After; nothing is sent until it passes. */
  pausedUntil: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ProviderLimiter {
  private readonly state = new Map<string, ProviderState>();
  private readonly opt: Required<LimiterOptions>;

  constructor(options: LimiterOptions = {}) {
    this.opt = {
      startConcurrency: options.startConcurrency ?? 4,
      minConcurrency: options.minConcurrency ?? 1,
      maxConcurrency: options.maxConcurrency ?? 8,
      startGapMs: options.startGapMs ?? 60,
      maxGapMs: options.maxGapMs ?? 4_000,
      recoverAfter: options.recoverAfter ?? 40,
    };
  }

  private for(provider: string): ProviderState {
    let s = this.state.get(provider);
    if (!s) {
      s = {
        concurrency: this.opt.startConcurrency,
        gapMs: this.opt.startGapMs,
        inFlight: 0,
        nextFreeAt: 0,
        cleanRun: 0,
        refusals: 0,
        pausedUntil: 0,
      };
      this.state.set(provider, s);
    }
    return s;
  }

  /**
   * Waits until this provider can take another request.
   *
   * Two gates, and both matter: a concurrency cap so we never hold more than N
   * connections open to one vendor, and a minimum gap so those N do not all
   * land in the same millisecond.
   */
  async acquire(provider: AtsProvider | string): Promise<void> {
    const s = this.for(provider);

    // Spin rather than queue: the caller is one of a small pool of workers, and
    // a 15ms poll is far simpler than a promise queue for the same result.
    while (s.inFlight >= s.concurrency) await sleep(15);

    const now = Date.now();
    const readyAt = Math.max(s.nextFreeAt, s.pausedUntil, now);
    if (readyAt > now) await sleep(readyAt - now);

    s.inFlight++;
    s.nextFreeAt = Math.max(Date.now(), readyAt) + s.gapMs;
  }

  /** Always call this, whatever happened, or the provider leaks its slots. */
  release(provider: AtsProvider | string): void {
    const s = this.for(provider);
    s.inFlight = Math.max(0, s.inFlight - 1);
  }

  /**
   * The vendor pushed back. Retreat, hard.
   *
   * `retryAfterMs` is honoured when the vendor sends it, because a stated wait
   * beats a guessed one — capped, so a vendor asking for an hour does not park
   * the whole crawl.
   */
  refused(provider: AtsProvider | string, retryAfterMs?: number | null): void {
    const s = this.for(provider);
    s.refusals++;
    s.cleanRun = 0;
    s.concurrency = Math.max(this.opt.minConcurrency, Math.floor(s.concurrency / 2));
    s.gapMs = Math.min(this.opt.maxGapMs, Math.max(this.opt.startGapMs, s.gapMs * 2));
    if (retryAfterMs && retryAfterMs > 0) {
      s.pausedUntil = Date.now() + Math.min(retryAfterMs, 30_000);
    }
  }

  /** A clean response. Recovery is deliberately slow. */
  succeeded(provider: AtsProvider | string): void {
    const s = this.for(provider);
    s.cleanRun++;
    if (s.cleanRun < this.opt.recoverAfter) return;
    s.cleanRun = 0;
    if (s.concurrency < this.opt.maxConcurrency) s.concurrency++;
    if (s.gapMs > this.opt.startGapMs) {
      s.gapMs = Math.max(this.opt.startGapMs, Math.round(s.gapMs * 0.7));
    }
  }

  /** What each vendor taught us, for the run summary. */
  report(): { provider: string; concurrency: number; gapMs: number; refusals: number }[] {
    return [...this.state]
      .map(([provider, s]) => ({
        provider,
        concurrency: s.concurrency,
        gapMs: s.gapMs,
        refusals: s.refusals,
      }))
      .filter((r) => r.refusals > 0 || r.gapMs > this.opt.startGapMs)
      .sort((a, b) => b.refusals - a.refusals);
  }
}
