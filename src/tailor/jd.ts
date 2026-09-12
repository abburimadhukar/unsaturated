import { getAdapter } from '../ats/adapters/index.js';
import { fetchDetail } from '../ats/describe.js';
// The same HTML stripper the adapters use. Workable's description field is HTML
// and this route is the only one that reads it without an adapter in between.
import { stripHtml } from '../ats/normalize.js';
import type { AtsProvider, BoardRef, FetchContext, NormalizedJob } from '../ats/types.js';
import { config } from '../config.js';
// Shared with the feed, which decides whether to offer the button at all. One
// list, so the UI and the fetcher cannot disagree about what is possible.
import { FROM_DETAIL, FROM_LISTING, WITH_DETAILS_PARAM, canDescribe } from './providers.js';

/**
 * Getting one job's description, at the moment somebody asks for it.
 *
 * WHY IT IS FETCHED AND NOT READ
 *
 * There is no `description` column and there never has been. The crawler reads
 * each body, classifies from it and discards it — 66,000 postings of somebody
 * else's copyrighted text that change underneath us and can be asked for again.
 * Tailoring needs one of them, for one job, at the moment a person opens it.
 *
 * So this reconstructs enough of a crawl to ask the vendor for a single posting.
 *
 * WHAT THE KEY ALREADY TELLS US
 *
 * A job key is `provider:token:externalId`, which is most of what a vendor needs.
 * The useful accident is Workday: its adapter sets `externalId` to the posting's
 * `externalPath`, the canonical URL path, which is exactly what its detail
 * endpoint wants. So the one field that is NOT stored — `raw.externalPath` —
 * turns out to be recoverable from the key, and Workday is 47% of the corpus.
 *
 * TWO ROUTES, AND ONE HONEST DEAD END
 *
 *   DETAIL PAGE   workday, smartrecruiters, workable, bamboohr. One request for
 *                 one posting, via the fetchDetail the crawl already uses.
 *
 *   BOARD LISTING greenhouse, lever, ashby, socrata, usajobs. Their listings
 *                 already carry descriptions, so there is no detail endpoint to
 *                 call; the board is fetched through its own adapter and the
 *                 posting picked out. Heavier — a large board is megabytes — but
 *                 it reuses a code path proven in production rather than a
 *                 per-job URL I would be guessing at. Guessing an endpoint is how
 *                 you ship a feature that 404s on contact.
 *
 *   NEITHER       personio, breezy, rippling, teamtailor, recruitee, ukg. No
 *                 description anywhere we can reach. Measured on the live corpus
 *                 on 12 September 2026: 5,727 open in-scope postings, of which
 *                 1,138 are cloud or data roles. Those cannot be tailored at all.
 *
 * That last group is why this returns a reason rather than an empty string. "No
 * description available from this ATS" is a true sentence a person can act on;
 * tailoring against a job title would be a confident answer to a question nobody
 * could answer.
 */

/**
 * Below this many characters a "description" is a stub and not worth tailoring
 * against — a location line, a one-sentence teaser, an application instruction.
 * The same floor the browser-side resume extraction uses for the same reason.
 */
export const MIN_USEFUL_CHARS = 200;

export interface JobIdentity {
  provider: AtsProvider;
  token: string;
  externalId: string;
}

/**
 * The three parts of a job key.
 *
 * Split on the FIRST TWO colons only. An externalId may contain colons — and for
 * Workday it is a URL path that certainly contains slashes — so splitting on
 * every colon would truncate the identifier and ask the vendor about a posting
 * that does not exist.
 */
export function parseJobKey(key: string): JobIdentity | null {
  const first = key.indexOf(':');
  if (first <= 0) return null;
  const second = key.indexOf(':', first + 1);
  if (second <= first + 1) return null;
  const externalId = key.slice(second + 1);
  if (!externalId) return null;
  return {
    provider: key.slice(0, first) as AtsProvider,
    token: key.slice(first + 1, second),
    externalId,
  };
}

export { canDescribe } from './providers.js';

export type JdResult =
  | { ok: true; text: string; via: 'detail' | 'listing' }
  | {
      ok: false;
      /** A sentence for the person, not a code. */
      reason: string;
      /**
       * False when no amount of retrying will help because this ATS has no
       * description path. Lets the UI hide the button rather than offer a
       * feature that cannot work here.
       */
      retryable: boolean;
    };

export interface DescribeOptions {
  /** Workday needs its tenant host and portal; both live on the board row. */
  extra?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Caps a listing fetch.
   *
   * Generous on purpose. Too low and the posting being looked for is simply not
   * in the page that came back, which would read as "no description" for a job
   * that has one — a wrong answer rather than a slow one.
   */
  maxJobs?: number;
  /** Overrides MAX_BODY_BYTES. Only the tests set this. */
  maxBytes?: number;
}

const DEFAULT_MAX_JOBS = 5_000;

function context(opts: DescribeOptions): FetchContext {
  return {
    userAgent: config.userAgent,
    timeoutMs: opts.timeoutMs ?? config.timeoutMs,
    maxJobs: opts.maxJobs ?? DEFAULT_MAX_JOBS,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
}

/**
 * A stand-in for the crawled job, carrying only what a detail fetcher reads.
 *
 * `raw.externalPath` is set from the externalId because that is what Workday's
 * adapter put there in the first place — see the header. The other three detail
 * fetchers read `externalId` directly and ignore `raw` entirely.
 */
function stubJob(id: JobIdentity, title: string): NormalizedJob {
  return {
    externalId: id.externalId,
    title,
    raw: { externalPath: id.externalId },
  };
}

/**
 * Most bytes read from a vendor in one go.
 *
 * 8 MB. Workable's details listing applies to a whole account, and one recruiting
 * agency in the corpus publishes 2,141 postings for 15.5 MB — in a Worker that is
 * a parse nobody asked for, to find one job. The median board is 2 jobs, so this
 * ceiling refuses the outlier and is invisible to everything else.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * A response body, or null if it exceeds the ceiling.
 *
 * STREAMED, BECAUSE THE HEADER CANNOT BE TRUSTED
 *
 * The obvious implementation checks content-length first. Measured against the
 * live vendor on 12 September 2026, Workable sends NO content-length on this
 * endpoint — the response is chunked — so a header check would wave through a
 * body of any size and the ceiling would be decoration.
 *
 * So the bytes are counted as they arrive and the read is abandoned the moment it
 * goes over, which also means the ceiling costs nothing on a small board.
 */
async function readCapped(res: Response, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const body = res.body;
  // No stream available (some fetch implementations in tests). Fall back to
  // buffering and then checking, which is still correct, merely less frugal.
  if (!body) {
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel();
        return null;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Workable, whose descriptions live only in the whole-account listing.
 *
 * Its per-posting endpoint returns 404 for every shape tried, so there is nothing
 * to ask about one job. The account listing with ?details=true carries a
 * `description` per posting, and the posting is found by shortcode — which is what
 * the adapter stored as the externalId.
 */
async function workableDescription(
  id: JobIdentity,
  opts: DescribeOptions,
): Promise<JdResult> {
  const url =
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(id.token)}` +
    '?details=true';
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    headers: { 'user-agent': config.userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? config.timeoutMs),
  });
  if (!res.ok) {
    return {
      ok: false,
      reason: `Workable answered ${res.status} for this employer — try again shortly`,
      retryable: true,
    };
  }

  const text = await readCapped(res, opts.maxBytes);
  if (text === null) {
    // Honest rather than silent. This employer publishes more postings than is
    // worth downloading to read one of them.
    return {
      ok: false,
      reason: 'this employer publishes too many postings for us to read one of them',
      retryable: false,
    };
  }

  let jobs: { shortcode?: string; description?: string }[] = [];
  try {
    jobs = (JSON.parse(text) as { jobs?: typeof jobs }).jobs ?? [];
  } catch {
    return { ok: false, reason: 'Workable returned something unreadable', retryable: true };
  }

  const found = jobs.find((j) => j.shortcode === id.externalId);
  if (!found) {
    return {
      ok: false,
      reason: 'this posting is no longer on the employer board — it may have closed',
      retryable: false,
    };
  }
  const body = (stripHtml(found.description ?? '') ?? '').trim();
  if (body.length >= MIN_USEFUL_CHARS) return { ok: true, text: body, via: 'listing' };
  return {
    ok: false,
    reason: 'the employer did not publish a description for this posting',
    retryable: true,
  };
}

/**
 * One job's description, or a reason there is none.
 *
 * Never throws. This sits behind a web request with a person waiting on it, and
 * a vendor being slow or unreachable is an ordinary Tuesday rather than an
 * exception. Every failure comes back as a sentence.
 */
export async function describeJob(
  job: { key: string; title: string },
  opts: DescribeOptions = {},
): Promise<JdResult> {
  const id = parseJobKey(job.key);
  if (!id) {
    return { ok: false, reason: 'that job reference is not one we can look up', retryable: false };
  }

  if (!canDescribe(id.provider)) {
    return {
      ok: false,
      reason: `${id.provider} does not publish job descriptions anywhere we can read them`,
      retryable: false,
    };
  }

  const board: BoardRef = {
    provider: id.provider,
    token: id.token,
    ...(opts.extra ? { extra: opts.extra } : {}),
  };

  // Workday's detail URL is built from the tenant host and the portal, and both
  // live on the board row rather than in the job key. Without them the request
  // would be made against an undefined host, so say so instead.
  if (id.provider === 'workday' && (!opts.extra?.host || !opts.extra?.site)) {
    return {
      ok: false,
      reason: 'this board is missing the address we need to read its postings',
      retryable: false,
    };
  }

  try {
    if (WITH_DETAILS_PARAM.includes(id.provider)) {
      return await workableDescription(id, opts);
    }

    if (FROM_DETAIL.includes(id.provider)) {
      const detail = await fetchDetail(board, stubJob(id, job.title), context(opts));
      const text = (detail?.description ?? '').trim();
      if (text.length >= MIN_USEFUL_CHARS) return { ok: true, text, via: 'detail' };
      return {
        ok: false,
        reason: text
          ? 'this posting has only a stub of a description'
          : 'the employer did not publish a description for this posting',
        // An empty detail page today can be filled in tomorrow; a stub is a
        // choice the employer made. Both are worth another look later, neither
        // is worth telling the person to retry now.
        retryable: true,
      };
    }

    // Listing route. The adapter is the same one the crawl uses, so whatever it
    // can read here it could read there.
    const jobs = await getAdapter(id.provider).fetchJobs(board, context(opts));
    const found = jobs.find((j) => j.externalId === id.externalId);
    if (!found) {
      // Almost always because the posting has closed between the crawl and now,
      // which is worth saying plainly — it is the most useful thing a person
      // could learn about a job they were about to spend effort on.
      return {
        ok: false,
        reason: 'this posting is no longer on the employer board — it may have closed',
        retryable: false,
      };
    }
    const text = (found.descriptionText ?? '').trim();
    if (text.length >= MIN_USEFUL_CHARS) return { ok: true, text, via: 'listing' };
    return {
      ok: false,
      reason: 'the employer did not publish a description for this posting',
      retryable: true,
    };
  } catch (err) {
    // Logged, not shown. A vendor's HTTP error text is not something to put in
    // front of a person, and it is the only place the actual cause is recorded.
    console.error(`describeJob ${job.key} failed:`, err instanceof Error ? err.message : err);
    return {
      ok: false,
      reason: `could not reach ${id.provider} just now — try again in a moment`,
      retryable: true,
    };
  }
}
