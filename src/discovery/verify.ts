import type { AtsProvider } from '../ats/types.js';
import type { OpenBoard } from './opendata.js';

/**
 * Confirms a board answers before we trust it.
 *
 * Open-dataset tokens are a historical harvest, so a large share are dead —
 * measured live rates on 31 Aug 2026 were Greenhouse 70%, Ashby 73%, Lever 47%,
 * Workday 38%.
 *
 * The important detail is HOW to check. Greenhouse drops connections under burst
 * from a datacenter IP, and a dropped connection is not a 404: a token that
 * failed in a fast batch returned HTTP 200 with 730 KB of jobs seconds later on
 * its own. A naive verifier reads those as dead and deletes thousands of working
 * boards. So a transport error is never a verdict — only a real HTTP status is.
 */

export type Verdict = 'live' | 'dead' | 'unknown';

export interface VerifyResult {
  board: OpenBoard;
  verdict: Verdict;
  jobs: number;
  status: number | null;
  /** Corporate domain, where the board's own payload reveals it. */
  domain?: string;
}

function endpoint(b: OpenBoard): { url: string; init?: RequestInit } | null {
  switch (b.provider) {
    case 'greenhouse':
      return { url: `https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs` };
    case 'lever':
      return { url: `https://api.lever.co/v0/postings/${b.token}?mode=json` };
    case 'ashby':
      return { url: `https://api.ashbyhq.com/posting-api/job-board/${b.token}` };
    case 'workday': {
      const host = b.extra?.host;
      const site = b.extra?.site;
      if (!host || !site) return null;
      return {
        url: `https://${host}/wday/cxs/${b.token}/${site}/jobs`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
        },
      };
    }
    // The four below were absent, and their absence was silent. `endpoint`
    // returning null makes a board "unknown", and only `live` boards are ever
    // stored — so a discovery run for personio, smartrecruiters or workable
    // harvested thousands of candidates, verified every one as unclear, stored
    // nothing, and reported success. 1,667 Personio boards were found and
    // dropped that way.
    case 'personio':
      // XML rather than JSON, which the reader below now allows for.
      return { url: `https://${b.token}.jobs.personio.de/xml` };
    case 'smartrecruiters':
      return {
        url: `https://api.smartrecruiters.com/v1/companies/${b.token}/postings?limit=1`,
      };
    case 'workable':
      return { url: `https://apply.workable.com/api/v1/widget/accounts/${b.token}` };
    case 'breezy':
      return { url: `https://${b.token}.breezy.hr/json` };
    default:
      return null;
  }
}

function countJobs(provider: AtsProvider, body: unknown): number {
  // Personio answers in XML, so the body arrives as a string. Counting the
  // position elements is enough to tell a live board from an empty one, which
  // is all this needs to decide.
  if (typeof body === 'string') {
    return (body.match(/<position[\s>]/gi) ?? []).length;
  }
  if (!body || typeof body !== 'object') return 0;
  const o = body as Record<string, unknown>;
  if (provider === 'workday') return typeof o.total === 'number' ? o.total : 0;
  if (provider === 'smartrecruiters') return typeof o.totalFound === 'number' ? o.totalFound : 0;
  if (provider === 'workable' && Array.isArray(o.jobs)) return o.jobs.length;
  if (Array.isArray(o.jobs)) return o.jobs.length;
  if (Array.isArray(o.data)) return o.data.length;
  if (Array.isArray(body)) return (body as unknown[]).length;
  return 0;
}

/**
 * Greenhouse hands back the employer's own domain for free.
 *
 * When a company hosts its board on its own site, `absolute_url` is a link to
 * that site — so verifying a token also closes the token-to-domain loop with no
 * enrichment vendor involved.
 */
function domainFrom(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const jobs = (body as { jobs?: { absolute_url?: string }[] }).jobs;
  const url = jobs?.find((j) => typeof j.absolute_url === 'string')?.absolute_url;
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // The ATS's own host tells us nothing about the employer.
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com/.test(host)) return undefined;
    return host;
  } catch {
    return undefined;
  }
}

export interface VerifyOptions {
  userAgent: string;
  /** Milliseconds between requests. Below ~1000 Greenhouse starts refusing. */
  delayMs?: number;
  timeoutMs?: number;
  onResult?: (r: VerifyResult, done: number, total: number) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function verifyBoards(
  boards: OpenBoard[],
  opts: VerifyOptions,
): Promise<VerifyResult[]> {
  const delayMs = opts.delayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const out: VerifyResult[] = [];

  for (const board of boards) {
    const target = endpoint(board);
    if (!target) {
      out.push({ board, verdict: 'unknown', jobs: 0, status: null });
      continue;
    }

    let result: VerifyResult = { board, verdict: 'unknown', jobs: 0, status: null };
    // One retry, because the first failure is far more often a rate limit than a
    // dead board.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(target.url, {
          ...target.init,
          headers: {
            'user-agent': opts.userAgent,
            accept: 'application/json',
            ...(target.init?.headers ?? {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 429 || res.status >= 500) {
          // Explicitly not a verdict about the board.
          result = { board, verdict: 'unknown', jobs: 0, status: res.status };
          await sleep(delayMs * 4);
          continue;
        }
        if (!res.ok) {
          result = { board, verdict: 'dead', jobs: 0, status: res.status };
          break;
        }

        // Personio serves XML. Reading it as text and letting countJobs decide
        // keeps one code path for every provider; JSON parsing a feed that is
        // not JSON would otherwise report a perfectly live board as unclear.
        const body: unknown =
          board.provider === 'personio'
            ? await res.text().catch(() => null)
            : await res.json().catch(() => null);
        const domain = board.provider === 'greenhouse' ? domainFrom(body) : undefined;
        result = {
          board,
          verdict: 'live',
          jobs: countJobs(board.provider, body),
          status: res.status,
          ...(domain ? { domain } : {}),
        };
        break;
      } catch {
        // Transport error: connection dropped, DNS failure, timeout. Never
        // treated as dead — this is exactly the Greenhouse burst behaviour.
        result = { board, verdict: 'unknown', jobs: 0, status: null };
        await sleep(delayMs * 4);
      }
    }

    out.push(result);
    opts.onResult?.(result, out.length, boards.length);
    await sleep(delayMs);
  }

  return out;
}
