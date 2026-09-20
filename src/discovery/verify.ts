import {
  oracleCompanyFrom,
  oracleCompanyFromPage,
  oracleSearchUrl,
  oracleSitePageUrl,
} from '../ats/adapters/oracle.js';
import { WORKDAY_SHARDS, discoverWorkdaySite } from '../ats/adapters/workday.js';
import { eightfoldCompanyFrom, eightfoldListUrl } from '../ats/adapters/eightfold.js';
import { icimsCompanyFrom } from '../ats/adapters/icims.js';
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
  /**
   * Whether the body could be read as the format the endpoint promises.
   *
   * A 200 is not proof of a board. `teamtailor:app`, `discover` and
   * `integrations` are Teamtailor's OWN marketing subdomains, swept in from the
   * URL index; they answer 200 to `/jobs.json` with a landing page, so they look
   * live and count zero jobs — exactly like a real board with nothing open.
   * Only the parse separates them, which matters because boards-revive uses this
   * to decide what comes back.
   */
  parsed?: boolean;
  /** Corporate domain, where the board's own payload reveals it. */
  domain?: string;
  /**
   * The employer's real name, where only the vendor knows it.
   *
   * Discovery names a board by title-casing its token, which works because most
   * tokens are the company: greenhouse/stripe is Stripe. Oracle's are not —
   * tenants are opaque four-letter codes, so `hccz` is stored as "Hccz" and
   * shown that way in the feed unless something better is found. It is Pearson.
   *
   * The first discovery run proved this is not a nicety: 764 Oracle boards
   * landed, and among them Tata Capital, Lifepoint Health, WSP and Kotak
   * Mahindra Bank were recorded as Eofh, Ibnjjb, Emit and Hcbt.
   */
  company?: string;
  /**
   * Fields the check had to work out for itself, to be stored with the board.
   *
   * Workday is the case. A tenant harvested from myworkdaysite.com names no
   * shard, and the same board answers on several — so verification probes for
   * the one that works and the answer has to survive, or the stored row would
   * fail every crawl forever.
   */
  extra?: Record<string, string>;
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
    // Rippling was missing, and its absence was silent in the way this whole
    // function warns about: no case means `endpoint` returns null, which makes
    // every candidate "unknown", and only `live` boards are ever stored. Wiring
    // discovery to Rippling without this would harvest 937 tokens, verify none
    // of them, store nothing, and report success — which is exactly how 1,667
    // Personio boards were lost.
    //
    // The response is a BARE ARRAY of postings, so countJobs falls through to
    // its Array.isArray(body) branch. Verified 9 Sep 2026: 23 of 25 unregistered
    // tokens sampled from the index answered 200, carrying 10.8 jobs each.
    case 'rippling':
      return { url: `https://api.rippling.com/platform/api/ats/v1/board/${b.token}/jobs` };
    // Oracle needs the same two identifiers the adapter does. Without both, a
    // stored row can never be fetched — so no host or no site means no check,
    // which is what "unknown" is for.
    case 'oracle': {
      const host = b.extra?.host;
      const site = b.extra?.site;
      if (!host || !site) return null;
      return { url: oracleSearchUrl(host, site, 1, 0) };
    }
    // Eightfold refuses without the employer's own domain, and a wrong one is a
    // 404 — so no domain means no check. Gated tenants answer 403, which is not
    // a live verdict, so they are never stored.
    case 'eightfold': {
      const domain = b.extra?.domain ?? b.extra?.site;
      if (!domain) return null;
      return { url: eightfoldListUrl(b.token, domain, 0, 1) };
    }
    case 'recruitee':
      return { url: `https://${b.token}.recruitee.com/api/offers/` };
    case 'teamtailor':
      return { url: `https://${b.token}.teamtailor.com/jobs.json` };
    case 'bamboohr':
      return {
        url: `https://${b.token}.bamboohr.com/careers/list`,
        // redirect: 'manual' matters more than it looks. A BambooHR tenant that
        // does not exist answers 302 to a marketing page, and fetch follows
        // redirects by default — so the check would land on a cheerful 200 of
        // HTML and record every dead board as live. Left manual, the 302 is
        // seen for what it is.
        init: { redirect: 'manual' },
      };
    case 'ukg': {
      // Two identifiers, like Workday: a company code and a board id, and
      // neither works without the other.
      const boardId = b.extra?.board;
      if (!boardId) return null;
      // The host is part of the board's identity: a board on recruiting2 does
      // not answer on recruiting. Older rows carry no host, so the original one
      // is the default.
      const host = b.extra?.host ?? 'recruiting.ultipro.com';
      return {
        url: `https://${host}/${b.token}/JobBoard/${boardId}/JobBoardView/LoadSearchResults`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ opportunitySearch: { Top: 1, Skip: 0, QuerySort: [], SearchText: '' } }),
        },
      };
    }
    // The same server-rendered listing the adapter reads. A dead token's host
    // is simply gone and answers 404, which is what makes an HTML provider
    // verifiable at all: there is no "empty board" that looks like a live one.
    case 'icims':
      return { url: `https://careers-${b.token}.icims.com/jobs/search?ss=1&in_iframe=1` };
    default:
      return null;
  }
}

function countJobs(provider: AtsProvider, body: unknown): number {
  // Personio answers in XML, so the body arrives as a string. Counting the
  // position elements is enough to tell a live board from an empty one, which
  // is all this needs to decide.
  if (typeof body === 'string') {
    // iCIMS answers in HTML, and one posting is one /jobs/{id}/ link. Distinct
    // ids, because each card links to the same posting more than once.
    if (provider === 'icims') {
      return new Set([...body.matchAll(/\/jobs\/(\d+)\//g)].map((m) => m[1])).size;
    }
    return (body.match(/<position[\s>]/gi) ?? []).length;
  }
  if (!body || typeof body !== 'object') return 0;
  const o = body as Record<string, unknown>;
  if (provider === 'workday') return typeof o.total === 'number' ? o.total : 0;
  // Oracle wraps one search result in `items`, and the count that matters is
  // the site's total rather than the page we asked for — the check asks for a
  // single posting, so counting the array would report every live board as 1.
  if (provider === 'oracle') {
    const search = Array.isArray(o.items) ? (o.items[0] as Record<string, unknown> | undefined) : undefined;
    return typeof search?.TotalJobsCount === 'number' ? search.TotalJobsCount : 0;
  }
  if (provider === 'smartrecruiters') return typeof o.totalFound === 'number' ? o.totalFound : 0;
  // `count` is the board's total; `positions` is only the one row asked for.
  if (provider === 'eightfold') return typeof o.count === 'number' ? o.count : 0;
  if (provider === 'ukg') return typeof o.totalCount === 'number' ? o.totalCount : 0;
  if (provider === 'bamboohr') return Array.isArray(o.result) ? o.result.length : 0;
  if (provider === 'recruitee') return Array.isArray(o.offers) ? o.offers.length : 0;
  // A JSON Feed, so the jobs are `items` rather than anything job-shaped.
  if (provider === 'teamtailor') return Array.isArray(o.items) ? o.items.length : 0;
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

/**
 * What the vendor actually said, printed after every verification pass.
 *
 * Added because a real failure was invisible for five consecutive runs.
 * Greenhouse discovery reported `live 0 · dead 701 · unclear 0` and stored
 * nothing, four runs in a row — 1,677 candidates, all rejected. Checked by hand
 * from a laptop, 9 of 30 of those same tokens answered HTTP 200 with real jobs:
 * Airbnb (168), Adyen (231), Affirm (204), Airtable (16), Abnormal Security
 * (68), Alarm.com (86). None of them are in the registry. Ashby shows the same
 * pattern.
 *
 * The reason nobody could say WHY is that the verdict was all we ever recorded.
 * "Dead" covers 404 (the board really is gone), 403 (we are being blocked),
 * 401, and 451 — completely different situations that demand opposite
 * responses, and the log flattened them into one word.
 *
 * So this prints the status codes. If the answers are 404, those boards are
 * genuinely gone and the registry is simply well saturated. If they are 403 or
 * 429, we are being turned away from a datacenter IP and the verdicts are
 * worthless — and the warning below says so rather than leaving it to be
 * noticed.
 */
export function summariseVerification(results: VerifyResult[]): string {
  const live = results.filter((r) => r.verdict === 'live').length;
  const unclear = results.filter((r) => r.verdict === 'unknown').length;
  const dead = results.length - live - unclear;

  const byStatus = new Map<string, number>();
  for (const r of results) {
    const key = r.status === null ? 'transport error (no response)' : `HTTP ${r.status}`;
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }

  const lines = [
    `\n  live ${live} · dead ${dead} · unclear ${unclear}`,
    '  what the vendor answered:',
    ...[...byStatus]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `    ${String(n).padStart(5)}  ${k}`),
  ];

  // A handful of the rejected tokens by name, so a claim of "all dead" can be
  // checked by hand in seconds instead of being taken on trust.
  const rejected = results.filter((r) => r.verdict === 'dead').slice(0, 8);
  if (rejected.length > 0) {
    lines.push('  a sample of the rejected, to spot-check:');
    for (const r of rejected) {
      lines.push(`    ${r.board.provider}:${r.board.token} → HTTP ${r.status}`);
    }
  }

  // The signature of being blocked rather than of finding dead boards.
  //
  // Some genuinely-dead residue is normal — the registry already holds the live
  // ones, so what is left over is enriched for the gone. A whole batch with not
  // one survivor is not that.
  const BLOCK_SUSPICION_MIN = 20;
  if (results.length >= BLOCK_SUSPICION_MIN && live === 0) {
    const worst = [...byStatus].sort((a, b) => b[1] - a[1])[0];
    lines.push(
      `\n  WARNING: not one of ${results.length} boards answered. That is the shape of`,
      `  being blocked, not of finding dead boards. Dominant answer: ${worst?.[0]}.`,
      '  Check that status by hand before trusting this run.',
    );
  }

  return lines.join('\n');
}

/**
 * An Oracle career site's page title, or nothing.
 *
 * One extra request per Oracle candidate, and it buys the difference between
 * "Ibnjjb" and "Lifepoint Health" in the feed. Costed before adding: at the
 * one-request-a-second verification pace it roughly doubles Oracle's share of a
 * discovery run, which is minutes against a budget measured in hours.
 *
 * Every failure returns undefined rather than throwing. This is a nicety on top
 * of a verdict that has already been reached from the API — a career site that
 * will not serve its own front page has still answered the jobs endpoint, and
 * must not be recorded as dead because of it.
 */
async function oracleTitle(
  board: OpenBoard,
  userAgent: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const host = board.extra?.host;
  const site = board.extra?.site;
  if (!host || !site) return undefined;
  try {
    const res = await fetch(oracleSitePageUrl(host, site), {
      headers: { 'user-agent': userAgent, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    // The title is in the head, so the whole page is not needed and some of
    // these are large single-page applications.
    return oracleCompanyFromPage((await res.text()).slice(0, 20_000));
  } catch {
    return undefined;
  }
}

/**
 * Fills in what a candidate needs before it can be checked at all.
 *
 * ONE CASE, AND IT IS WORKDAY'S SECOND ADDRESS
 *
 * Workday serves the same board from two hostnames. `{tenant}.wd3.myworkdayjobs.com`
 * names its shard; `wd1.myworkdaysite.com/en-US/recruiting/{tenant}/{site}` does
 * not — the wd1 in that address is the site's own front door, not the tenant's
 * pod. Measured 15 September 2026, that is not a detail: of eight tenants found
 * only on myworkdaysite, three answered on wd3 and wd12 rather than wd1, so
 * taking the hostname at face value would have recorded them as dead.
 *
 * Both addresses return byte-identical totals for a tenant we already hold —
 * fmr/FidelityCareers 636 on each, wf/WellsFargoJobs 1792 on each — so the
 * second domain is not a second estate and must never be stored as one. That
 * would register Fidelity twice under two hosts, which is exactly the duplicate
 * the 2026-09-07 site migration exists to prevent. The value in those URLs is
 * the TENANT NAME: 38 of the 58 found there were in no registry at all.
 *
 * So the harvest records the tenant and the site, and the shard is discovered
 * here against the domain we already crawl.
 */
async function resolveBeforeCheck(board: OpenBoard): Promise<OpenBoard> {
  if (board.provider !== 'workday') return board;
  const site = board.extra?.site;
  if (!site || board.extra?.host) return board;

  // Eight shards, one known site name: at most eight requests, and usually one
  // or two. Guessing site names as well would be ninety.
  const found = await discoverWorkdaySite(board.token, WORKDAY_SHARDS.length, [site]);
  if (!found) return board;
  return {
    ...board,
    extra: { ...board.extra, host: found.host, site: found.site, locale: found.locale },
  };
}

export async function verifyBoards(
  boards: OpenBoard[],
  opts: VerifyOptions,
): Promise<VerifyResult[]> {
  const delayMs = opts.delayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const out: VerifyResult[] = [];

  for (const board of boards) {
    const resolved = await resolveBeforeCheck(board);
    const target = endpoint(resolved);
    if (!target) {
      out.push({ board, verdict: 'unknown', jobs: 0, status: null });
      continue;
    }
    // Anything the resolution worked out has to reach the caller, or the stored
    // row is the half-formed one that could not be checked in the first place.
    const gained =
      resolved.extra !== board.extra ? { extra: resolved.extra as Record<string, string> } : {};

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
        // iCIMS serves HTML, like Personio's XML: read it as text and let
        // countJobs decide, rather than JSON-parsing a page that is not JSON
        // and reporting a live board as unclear.
        const body: unknown =
          board.provider === 'personio' || board.provider === 'icims'
            ? await res.text().catch(() => null)
            : await res.json().catch(() => null);
        const domain = board.provider === 'greenhouse' ? domainFrom(body) : undefined;
        // Oracle's tokens are opaque codes, so the only place the employer's
        // name exists is the response we already have in hand.
        // The career site's own page title first, its organisation facet second.
        // The title is the name the employer chose — "Tata Capital" rather than
        // "Tata Capital Limited" — but a site left on Oracle's stock template
        // has no name in it at all, and those are the ones the facet answers.
        const company =
          board.provider === 'oracle'
            ? (await oracleTitle(board, opts.userAgent, timeoutMs)) ?? oracleCompanyFrom(body)
            : board.provider === 'eightfold'
              ? eightfoldCompanyFrom(body)
              : board.provider === 'icims'
                ? icimsCompanyFrom(body)
                : undefined;
        result = {
          board,
          verdict: 'live',
          jobs: countJobs(board.provider, body),
          status: res.status,
          // null is what the `.catch(() => null)` above leaves behind when the
          // body is not the format this endpoint promised — an HTML page where
          // JSON belongs. Recorded rather than flattened into "0 jobs".
          parsed: body !== null,
          ...(domain ? { domain } : {}),
          ...(company ? { company } : {}),
          ...gained,
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
