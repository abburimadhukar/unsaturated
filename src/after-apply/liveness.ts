/**
 * "Is this role even live?" — a read computed from the crawler's own signals.
 *
 * WHY THIS EXISTS
 *
 * The After applying research step finds people and company context, but for a
 * quiet role at an institution there is often no named recruiter anywhere on the
 * public web, so that step comes back with company context only. The one thing
 * we can always say — for free, with no model call — is whether the posting still
 * looks real, using data only this app has: the crawler re-reads every board and
 * records when it first and last saw each posting, closes postings that stop
 * appearing, and scores a `ghost_risk` the feed already trusts (it shows it as a
 * "ghost risk %" chip and sinks risky rows).
 *
 * Research on ghost jobs is the motivation — a large share of listings are
 * reposted perpetually with no intent to hire — but every number here is derived
 * from a real stored field. Nothing is invented: if we have no signal, we say so.
 */

/** The same threshold the feed and live.ts use to call a posting a ghost risk. */
export const GHOST_RISK_THRESHOLD = 0.4;

/** How recently the board was seen for us to call a posting "still listed". */
const FRESH_SEEN_DAYS = 2;

export type LivenessTone = 'live' | 'caution' | 'unknown';

export interface LivenessInput {
  postedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  closedAt: string | null;
  ghostRisk: number | null;
}

export interface Liveness {
  tone: LivenessTone;
  headline: string;
  /** Plain-English, source-derived lines. Never empty for a known posting. */
  points: string[];
}

function parse(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function days(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * Turn the stored crawl fields into a short, honest read. `now` is injected so
 * the age and "last seen" lines can be tested without a real clock.
 */
export function jobLiveness(input: LivenessInput, now: number = Date.now()): Liveness {
  const posted = parse(input.postedAt);
  const firstSeen = parse(input.firstSeenAt);
  const lastSeen = parse(input.lastSeenAt);
  const closed = parse(input.closedAt);
  const risk = typeof input.ghostRisk === 'number' && Number.isFinite(input.ghostRisk)
    ? Math.max(0, Math.min(1, input.ghostRisk))
    : null;
  const riskHigh = risk !== null && risk >= GHOST_RISK_THRESHOLD;

  const points: string[] = [];

  // 1) Listing status — the most concrete signal we have.
  if (closed !== null) {
    points.push(`No longer listed — the posting stopped appearing on the employer’s board ${count(days(closed, now), 'day')} ago.`);
  } else if (lastSeen !== null) {
    const since = days(lastSeen, now);
    points.push(since <= FRESH_SEEN_DAYS
      ? 'Still listed on the employer’s board as of our last crawl.'
      : `Last seen on the employer’s board ${count(since, 'day')} ago.`);
  }

  // 2) How long it has been open — posted date if we have it, else first seen.
  const openFrom = posted ?? firstSeen;
  if (openFrom !== null) {
    const age = days(openFrom, now);
    points.push(posted !== null
      ? `Posted about ${count(age, 'day')} ago.`
      : `First seen about ${count(age, 'day')} ago.`);
  }

  // 3) The crawler's ghost-risk read, phrased the way the feed chip is.
  if (risk !== null) {
    const pct = Math.round(risk * 100);
    points.push(riskHigh
      ? `Our crawler flags elevated ghost-job risk (${pct}%) — worth confirming the role is live before investing time.`
      : `Low ghost-job risk (${pct}%) on our crawler’s read.`);
  }

  // Tone and headline: a closed or risky posting earns a caution; a posting seen
  // recently with low risk looks live; anything with no signal stays honest.
  let tone: LivenessTone;
  let headline: string;
  if (closed !== null) {
    tone = 'caution';
    headline = 'This posting may be closed';
  } else if (riskHigh) {
    tone = 'caution';
    headline = 'Worth checking this role is live';
  } else if (lastSeen !== null || risk !== null) {
    tone = 'live';
    headline = 'This role looks live';
  } else {
    tone = 'unknown';
    headline = 'We can’t confirm this role’s status';
  }

  if (points.length === 0) {
    points.push('We don’t have fresh crawl signals for this posting.');
  }

  return { tone, headline, points };
}
