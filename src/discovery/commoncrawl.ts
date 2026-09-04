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
];

/** Path segments that are routing, not a company. */
const NOT_A_TOKEN =
  /^(embed|api|jobs?|search|apply|login|home|about|robots\.txt|sitemap\.xml|assets|static|images?|css|js|wday|en|en-us)$/i;

async function cdx(url: string, userAgent: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': userAgent },
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`CDX ${res.status}`);
  return res.text();
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

  const token = m[1];
  if (!token || NOT_A_TOKEN.test(token)) return null;
  return { provider: p.provider, token, company: titleise(token) };
}

export interface HarvestReport {
  provider: AtsProvider;
  pattern: string;
  urls: number;
  tokens: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
}): Promise<{ crawl: string; boards: OpenBoard[]; reports: HarvestReport[] }> {
  const crawl = opts.crawl ?? (await latestCrawl(opts.userAgent));
  const maxPages = opts.maxPagesPerPattern ?? 8;
  const delayMs = opts.delayMs ?? 1500;
  const seen = new Map<string, OpenBoard>();
  const reports: HarvestReport[] = [];

  for (const p of PATTERNS) {
    const base = `${INDEX_HOST}/${crawl}-index?url=${encodeURIComponent(p.match)}&output=json`;

    let pages = 0;
    try {
      const meta = await cdx(`${base}&showNumPages=true`, opts.userAgent);
      pages = Number((JSON.parse(meta || '{}') as { pages?: number }).pages ?? 0);
    } catch (err) {
      opts.onProgress?.(`  ${p.match}: index unavailable (${String(err)})`);
      reports.push({ provider: p.provider, pattern: p.match, urls: 0, tokens: 0 });
      continue;
    }
    if (pages === 0) {
      opts.onProgress?.(`  ${p.match}: nothing in this crawl`);
      reports.push({ provider: p.provider, pattern: p.match, urls: 0, tokens: 0 });
      continue;
    }

    let urls = 0;
    const before = seen.size;
    for (let page = 0; page < Math.min(pages, maxPages); page++) {
      let body: string;
      try {
        body = await cdx(`${base}&page=${page}`, opts.userAgent);
      } catch (err) {
        // A refused page loses that slice, not the whole harvest.
        opts.onProgress?.(`  ${p.match} page ${page}: ${String(err)}`);
        await sleep(delayMs * 4);
        continue;
      }

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
    reports.push({ provider: p.provider, pattern: p.match, urls, tokens });
    opts.onProgress?.(`  ${p.match.padEnd(32)} ${String(urls).padStart(7)} urls -> ${tokens} new`);
  }

  return { crawl, boards: [...seen.values()], reports };
}
