import { resolveApplyUrl } from '../ats/resolve.js';
import type { BoardRef } from '../ats/types.js';
import { config } from '../config.js';

/**
 * Reads a company's ATS off its own careers page.
 *
 * The slug-prober guesses a token from the company name, which works for
 * startups ("Vercel" -> vercel) and fails for everyone else. Universities are
 * the clearest example: Ohio State's Workday tenant is "osu", and Vanderbilt's
 * career site is called "VU_Careers" — no naming rule reaches either.
 *
 * Fetching the careers page instead removes the guessing entirely: employers
 * link to their own ATS, so the token is simply there to be read. It also finds
 * Workday sites with arbitrary names, which the shard x site matrix cannot.
 */

/** Where careers pages usually live, most conventional first. */
function candidateUrls(domain: string): string[] {
  const d = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return [
    `https://${d}/careers`,
    `https://careers.${d}`,
    `https://jobs.${d}`,
    `https://${d}/jobs`,
    `https://${d}/about/careers`,
    `https://hr.${d}/careers`,
  ];
}

/**
 * ATS links appear in href attributes, inline scripts and redirect targets, so
 * the whole document is searched rather than parsed as HTML.
 */
function extractBoards(html: string, finalUrl: string): BoardRef[] {
  const found = new Map<string, BoardRef>();

  // The page may itself have redirected onto the ATS.
  for (const candidate of [finalUrl, ...[...html.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)].map((m) => m[0])]) {
    const cleaned = candidate.replace(/[.,;:!?)\]}'"]+$/, '');
    const resolved = resolveApplyUrl(cleaned);
    if (resolved.status !== 'supported') continue;
    found.set(`${resolved.board.provider}:${resolved.board.token}`, resolved.board);
  }

  // Workday needs host + site, which resolveApplyUrl does not return — the
  // tenant alone is not enough to query it.
  for (const m of html.matchAll(
    /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([A-Za-z0-9_-]+)/g,
  )) {
    const [, tenant, shard, locale, site] = m;
    if (!tenant || !shard || !site) continue;
    // "wday" and "en-US" are path noise, not site names.
    if (/^(wday|en|login|home)$/i.test(site)) continue;
    found.set(`workday:${tenant}`, {
      provider: 'workday',
      token: tenant,
      extra: { host: `${tenant}.${shard}.myworkdayjobs.com`, site, locale: locale ?? 'en-US' },
    });
  }

  return [...found.values()];
}

export interface CareersResult {
  domain: string;
  boards: BoardRef[];
  /** URL that actually answered, for debugging misses. */
  via?: string;
}

export async function detectFromDomain(domain: string): Promise<CareersResult> {
  for (const url of candidateUrls(domain)) {
    try {
      const res = await fetch(url, {
        // A plain browser UA: several careers pages serve a bot wall otherwise,
        // and this is an ordinary public page either way.
        headers: { 'user-agent': `Mozilla/5.0 (compatible; ${config.userAgent})` },
        redirect: 'follow',
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;

      const html = await res.text();
      const boards = extractBoards(html, res.url);
      if (boards.length > 0) return { domain, boards, via: url };
    } catch {
      // Wrong guess or unreachable — try the next pattern.
    }
  }
  return { domain, boards: [] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function detectMany(
  domains: string[],
  concurrency = 6,
  onProgress?: (done: number, total: number, found: number) => void,
): Promise<CareersResult[]> {
  const results: CareersResult[] = [];
  let cursor = 0;
  let done = 0;
  let found = 0;

  const workers = Array.from({ length: Math.min(concurrency, domains.length) }, async () => {
    while (cursor < domains.length) {
      const domain = domains[cursor++];
      if (!domain) break;
      const r = await detectFromDomain(domain);
      results.push(r);
      if (r.boards.length > 0) found++;
      done++;
      onProgress?.(done, domains.length, found);
      await sleep(config.delayMs);
    }
  });

  await Promise.all(workers);
  return results;
}
