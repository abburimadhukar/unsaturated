import type { AtsProvider } from '../ats/types.js';
import type { OpenBoard } from './opendata.js';

/**
 * Harvests board tokens from Common Crawl's URL index.
 *
 * No ATS publishes a customer directory — Greenhouse's docs offer unauthenticated
 * reads with no way to ask who its customers are, and TheirStack, who sell this
 * data, say plainly that "public ATS APIs do not list their clients". So the
 * token has to come from somewhere the boards have already been seen: a
 * web-scale URL archive, where the token is simply the first path segment.
 *
 * Measured against CC-MAIN-2026-34: 45,803 indexed URLs for
 * job-boards.greenhouse.io alone, yielding 2,965 distinct tokens, and about
 * 25,000 across every pattern here. A new crawl lands roughly monthly, which is
 * what stops the registry going stale without anyone maintaining it by hand.
 *
 * Lever is deliberately absent. jobs.lever.co/robots.txt carries
 * `User-agent: CCBot / Disallow: /`, and CCBot is Common Crawl's own crawler, so
 * the current index holds 62 URLs for Lever — all of them the robots file. Lever
 * tokens come from the open dataset instead. Their `User-agent: *` rule is
 * `Allow: / Crawl-delay: 1`, so reading their boards directly, which is what the
 * crawler does, is what they permit.
 */

const INDEX_HOST = 'https://index.commoncrawl.org';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pattern {
  provider: AtsProvider;
  /** CDX url pattern. */
  match: string;
  /** Pulls the token out of a matched URL. */
  extract: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    provider: 'greenhouse',
    match: 'job-boards.greenhouse.io/*',
    extract: /job-boards\.greenhouse\.io\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
  },
  {
    provider: 'greenhouse',
    match: 'boards.greenhouse.io/*',
    extract: /boards\.greenhouse\.io\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
  },
  {
    provider: 'ashby',
    match: 'jobs.ashbyhq.com/*',
    extract: /jobs\.ashbyhq\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)/,
  },
  {
    provider: 'workday',
    match: '*.myworkdayjobs.com/*',
    extract: /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:([a-z]{2}(?:[-_][A-Za-z]{2})?)\/)?([A-Za-z0-9_-]+)/,
  },
  {
    provider: 'smartrecruiters',
    match: 'jobs.smartrecruiters.com/*',
    extract: /jobs\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
  },
  // SmartRecruiters serves boards from TWO hosts and we only ever read one.
  //
  // Measured 7 Sep 2026: careers.smartrecruiters.com holds 424 distinct tokens,
  // 234 of them unregistered, and 18 of 18 sampled answered live with 501 jobs
  // between them. It lands on the richest provider in the registry — 9.22 jobs
  // per board against Greenhouse's 2.52 — and we hold the fewest of them.
  //
  // Tokens here are mixed-case ("ATParchitekteningenieure"), unlike Greenhouse's
  // lowercase slugs, which is why the extraction keeps case and the dedup key
  // does not.
  {
    provider: 'smartrecruiters',
    match: 'careers.smartrecruiters.com/*',
    extract: /careers\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
  },
  {
    provider: 'workable',
    match: 'apply.workable.com/*',
    extract: /apply\.workable\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
  },
  // Personio puts the company in the SUBDOMAIN rather than the path, so the
  // token comes from the host — the same shape as Workday, and unlike every
  // other pattern here. Two TLDs because German customers are on .de and the
  // rest on .com; both resolve to the same XML endpoint.
  {
    provider: 'personio',
    match: '*.jobs.personio.de/*',
    extract: /https?:\/\/([a-z0-9][a-z0-9-]*)\.jobs\.personio\.de/i,
  },
  {
    provider: 'personio',
    match: '*.jobs.personio.com/*',
    extract: /https?:\/\/([a-z0-9][a-z0-9-]*)\.jobs\.personio\.com/i,
  },
  // BambooHR: the company is the subdomain, and only the careers pages count —
  // the marketing site lives on the same domain and would otherwise contribute
  // "www" as a board.
  {
    provider: 'bamboohr',
    match: '*.bamboohr.com/*',
    extract: /https?:\/\/([a-z0-9][a-z0-9-]*)\.bamboohr\.com\/(?:careers|jobs)/i,
  },
  // Recruitee and Teamtailor: the company is the subdomain. Both publish a
  // usable JSON listing with descriptions included, which is rarer than it
  // sounds — most providers make the description a second request per job.
  {
    provider: 'recruitee',
    match: '*.recruitee.com/*',
    extract: /https?:\/\/([a-z0-9][a-z0-9-]*)\.recruitee\.com/i,
  },
  {
    provider: 'teamtailor',
    match: '*.teamtailor.com/*',
    extract: /https?:\/\/([a-z0-9][a-z0-9-]*)\.teamtailor\.com/i,
  },
  // Rippling: the company is the first path segment, as clean as Greenhouse's.
  //
  //   ats.rippling.com/514-careers/jobs/5811104e-78bb-4aaa-a8f6-32bbad47654b
  //   ats.rippling.com/aaca/jobs
  //
  // Measured against CC-MAIN-2026-34 on 9 Sep 2026: one index page, 9,183
  // indexed URLs, 937 distinct tokens. Only 4 were registered. A spread sample
  // of 25 unregistered ones found 23 alive, averaging 10.8 postings each.
  //
  // Worth knowing before judging the yield: Rippling's feed carries a title, a
  // department, a location and a URL — no description and no publish date. So
  // these roles are classified from their title alone, and the in-scope share is
  // low. 202 postings sampled across ten boards produced 7 in a browsable
  // family — 3%. Rippling sells to small local employers, and most of them are
  // not hiring engineers.
  {
    provider: 'rippling',
    match: 'ats.rippling.com/*',
    extract: /ats\.rippling\.com\/([A-Za-z0-9][A-Za-z0-9_-]*)/,
  },
  // UKG needs BOTH halves of the URL: a company code and a board id. A match
  // that finds only the code is unusable, so the pattern demands both.
  // Both hosts, and the host is captured. UKG serves boards from
  // recruiting.ultipro.com AND recruiting2.ultipro.com, and a board on one does
  // not answer on the other: 618 boards were harvested from recruiting2,
  // verified against recruiting, and every single one came back 404 and was
  // recorded as dead.
  {
    provider: 'ukg',
    match: 'recruiting.ultipro.com/*',
    extract: /(recruiting2?\.ultipro\.com)\/([A-Za-z0-9_]+)\/JobBoard\/([0-9a-f-]{36})/i,
  },
  {
    provider: 'ukg',
    match: 'recruiting2.ultipro.com/*',
    extract: /(recruiting2?\.ultipro\.com)\/([A-Za-z0-9_]+)\/JobBoard\/([0-9a-f-]{36})/i,
  },
];

/** Path segments that are routing, not a company. */
const NOT_A_TOKEN =
  /^(embed|api|jobs?|search|apply|login|home|about|robots\.txt|sitemap\.xml|assets|static|images?|css|js|wday|en|en-us)$/i;

/**
 * One page of the index, with patience.
 *
 * Common Crawl's query server sheds load under pressure — 502, 503 and 504 all
 * appear — and a lost page is a silent hole in the candidate list, which is how
 * boards the size of Airbnb went missing for weeks. A refusal is temporary, so
 * it is worth waiting out: three attempts, doubling, rather than one and a
 * shrug.
 *
 * A 404 still returns empty immediately. That is the index saying it holds
 * nothing for this pattern, which no amount of retrying changes.
 */
async function cdx(url: string, userAgent: string, attempts = 3): Promise<string> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(2_000 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': userAgent },
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      continue;
    }
    if (res.status === 404) return '';
    if (res.ok) return res.text();
    lastStatus = res.status;
    // 4xx other than 404 will not improve by asking again.
    if (res.status < 500 && res.status !== 429) throw new Error(`CDX ${res.status}`);
  }
  throw new Error(`CDX ${lastStatus || 'unreachable'} after ${attempts} attempts`);
}

/** The most recent crawl collection, e.g. "CC-MAIN-2026-34". */
export async function latestCrawl(userAgent: string): Promise<string> {
  const res = await fetch(`${INDEX_HOST}/collinfo.json`, {
    headers: { 'user-agent': userAgent },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`collinfo: HTTP ${res.status}`);
  const all = (await res.json()) as { id: string }[];
  const id = all[0]?.id;
  if (!id) throw new Error('no crawl collections listed');
  return id;
}

function titleise(token: string): string {
  return token
    .replace(/[-_.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

function toBoard(p: Pattern, url: string): OpenBoard | null {
  const m = p.extract.exec(url);
  if (!m) return null;

  if (p.provider === 'workday') {
    const [, tenant, shard, , site] = m;
    if (!tenant || !shard || !site) return null;
    // The locale segment is optional in the URL, so a naive read mistakes
    // "en-US" for the site name. Measured: doing so dropped live-verification
    // from 11/12 to 4/10.
    if (NOT_A_TOKEN.test(site)) return null;
    return {
      provider: 'workday',
      token: tenant,
      company: titleise(tenant),
      extra: { host: `${tenant}.${shard}.myworkdayjobs.com`, site, locale: 'en-US' },
    };
  }

  if (p.provider === 'ukg') {
    // Same shape as Workday: two identifiers, and a board carrying only one of
    // them cannot be fetched or verified. Storing it would put a row in the
    // registry that fails every crawl forever.
    const [, host, code, boardId] = m;
    if (!host || !code || !boardId) return null;
    return {
      provider: 'ukg',
      token: code,
      company: titleise(code),
      extra: { board: boardId, host },
    };
  }

  const token = m[1];
  if (!token || NOT_A_TOKEN.test(token)) return null;
  return { provider: p.provider, token, company: titleise(token) };
}

export interface HarvestReport {
  provider: AtsProvider;
  pattern: string;
  urls: number;
  tokens: number;
  /** Index pages this pattern asked for and did not get. */
  pagesTotal: number;
  pagesRead: number;
}

/**
 * Reads every page of the index for each pattern.
 *
 * Common Crawl asks callers not to overload the query server, and it does start
 * refusing under sustained load, so this is paced and capped rather than run
 * flat out. For a full historical sweep their columnar index on S3 is the
 * documented route; this is sized for "what is new this month".
 */
export async function harvestCommonCrawl(opts: {
  userAgent: string;
  crawl?: string;
  maxPagesPerPattern?: number;
  delayMs?: number;
  onProgress?: (msg: string) => void;
  /**
   * Read only this vendor's patterns.
   *
   * Without it, all eleven jobs in the discovery matrix read the WHOLE index —
   * every pattern for every vendor — and then threw away all but their own
   * provider. Eleven times the load on Common Crawl's query server for exactly
   * one eleventh of the value, and it showed: a single run logged CDX 502, 503
   * and 504 across most patterns, three vendors read "0 urls -> 0 new", and the
   * same pattern returned 2,388, 2,410, 9,154 and 12,110 urls in four different
   * jobs of that one run.
   *
   * A refused page loses that slice silently, so each job ended up with a
   * different partial view of the index and the run still reported success.
   * That is why Greenhouse offered 701 candidates one run and 44 the next, and
   * why boards as large as Airbnb, Adyen and Affirm are live, in the index, and
   * still not in the registry — they simply never surfaced as candidates.
   */
  provider?: AtsProvider;
}): Promise<{ crawl: string; boards: OpenBoard[]; reports: HarvestReport[] }> {
  const crawl = opts.crawl ?? (await latestCrawl(opts.userAgent));
  const maxPages = opts.maxPagesPerPattern ?? 8;
  const delayMs = opts.delayMs ?? 1500;
  const seen = new Map<string, OpenBoard>();
  const reports: HarvestReport[] = [];

  // A provider with no pattern is a fact, not an error. Lever is the case:
  // jobs.lever.co/robots.txt carries `User-agent: CCBot / Disallow: /`, so the
  // index holds 62 URLs for it and every one is the robots file. Its tokens
  // come from the open dataset instead.
  //
  // This threw until now, which took the whole discovery workflow red on every
  // single run — and a failure signal that fires every time is one nobody
  // reads. Returning nothing lets the caller say so and move on.
  const patterns = opts.provider ? PATTERNS.filter((p) => p.provider === opts.provider) : PATTERNS;

  for (const p of patterns) {
    const base = `${INDEX_HOST}/${crawl}-index?url=${encodeURIComponent(p.match)}&output=json`;

    let pages = 0;
    try {
      const meta = await cdx(`${base}&showNumPages=true`, opts.userAgent);
      pages = Number((JSON.parse(meta || '{}') as { pages?: number }).pages ?? 0);
    } catch (err) {
      opts.onProgress?.(`  ${p.match}: index unavailable (${String(err)})`);
      reports.push({ provider: p.provider, pattern: p.match, urls: 0, tokens: 0, pagesTotal: 0, pagesRead: 0 });
      continue;
    }
    if (pages === 0) {
      opts.onProgress?.(`  ${p.match}: nothing in this crawl`);
      reports.push({ provider: p.provider, pattern: p.match, urls: 0, tokens: 0, pagesTotal: 0, pagesRead: 0 });
      continue;
    }

    let urls = 0;
    let pagesRead = 0;
    const before = seen.size;
    const wanted = Math.min(pages, maxPages);
    for (let page = 0; page < wanted; page++) {
      let body: string;
      try {
        body = await cdx(`${base}&page=${page}`, opts.userAgent);
      } catch (err) {
        // A refused page loses that slice, not the whole harvest — but it is
        // now COUNTED. Silently dropping a page is what let a run report
        // success while holding a different partial view of the index each
        // time, so a board could be live, present in the index, and never once
        // offered as a candidate.
        opts.onProgress?.(`  ${p.match} page ${page + 1}/${wanted}: LOST (${String(err)})`);
        await sleep(delayMs * 4);
        continue;
      }
      pagesRead++;

      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        urls++;
        let url: string;
        try {
          url = (JSON.parse(line) as { url: string }).url;
        } catch {
          continue;
        }
        const board = toBoard(p, url);
        if (!board) continue;
        const key =
          board.provider === 'workday'
            ? `workday:${board.token}:${board.extra?.site ?? ''}`
            : `${board.provider}:${board.token}`;
        if (!seen.has(key)) seen.set(key, board);
      }
      await sleep(delayMs);
    }

    const tokens = seen.size - before;
    reports.push({ provider: p.provider, pattern: p.match, urls, tokens, pagesTotal: wanted, pagesRead });
    opts.onProgress?.(`  ${p.match.padEnd(32)} ${String(urls).padStart(7)} urls -> ${tokens} new`);
  }

  return { crawl, boards: [...seen.values()], reports };
}
