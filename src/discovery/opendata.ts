import type { AtsProvider } from '../ats/types.js';

/**
 * Board tokens from published open datasets.
 *
 * The board list was hand-maintained: 1,437 tokens found by guessing company
 * slugs and reading Hacker News threads. That cannot reach the thousands of US
 * employers hiring, and no ATS publishes a customer directory — Greenhouse's own
 * docs offer unauthenticated reads with no way to ask who its customers are.
 *
 * It does not need to. Feashliaa/job-board-aggregator (MIT) harvested board
 * tokens out of Common Crawl's URL index, where they are simply the first path
 * segment of every archived board URL. Measured 31 Aug 2026: 60,422 tokens, of
 * which sampling against the live APIs put roughly 15,000 still answering on the
 * four providers we already read.
 *
 * Tokens are historical, so a large share are dead — companies churn ATS and
 * boards get renamed. Nothing here is trusted until cli/boards-verify.ts has
 * confirmed it answers.
 */

const BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

export interface OpenBoard {
  provider: AtsProvider;
  token: string;
  company: string;
  extra?: Record<string, string>;
}

/** Files we can act on today, i.e. providers with a working adapter. */
const SUPPORTED: { file: string; provider: AtsProvider }[] = [
  { file: 'greenhouse_companies.json', provider: 'greenhouse' },
  { file: 'lever_companies.json', provider: 'lever' },
  { file: 'ashby_companies.json', provider: 'ashby' },
  { file: 'workday_companies.json', provider: 'workday' },
];

/**
 * Files for ATSs we cannot read yet. Listed so the gap is visible in code rather
 * than forgotten: iCIMS and Cornerstone need headless rendering, BambooHR and
 * Paylocity need a scraper, and none has an adapter.
 */
export const UNSUPPORTED_FILES = [
  'icims_companies.json',
  'bamboohr_companies.json',
  'paylocity_companies_clean.json',
];

/** "vercel" -> "Vercel", "1uphealth" -> "1uphealth". Replaced on verification. */
function titleise(token: string): string {
  return token
    .replace(/[-_.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Workday needs three parts and the dataset supplies all of them as
 * "tenant|shard|site" — the shard follows no rule and the site is whatever the
 * customer named their careers page, so neither is reachable by guessing.
 */
function parseWorkday(entry: string): OpenBoard | null {
  const [tenant, shard, site] = entry.split('|');
  if (!tenant || !shard || !site) return null;
  if (!/^wd\d+$/i.test(shard)) return null;
  return {
    provider: 'workday',
    token: tenant,
    company: titleise(tenant),
    extra: { host: `${tenant}.${shard}.myworkdayjobs.com`, site, locale: 'en-US' },
  };
}

async function fetchJson(url: string, userAgent: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export interface FetchReport {
  provider: AtsProvider;
  raw: number;
  usable: number;
}

/**
 * Downloads every supported token file.
 *
 * Deduplicated on provider:token, because a company can appear in more than one
 * file (a board that migrated ATS leaves an entry in both) and the same tenant
 * can carry several Workday sites.
 */
export async function fetchOpenBoards(
  userAgent: string,
  onProgress?: (file: string, count: number) => void,
): Promise<{ boards: OpenBoard[]; reports: FetchReport[] }> {
  const seen = new Map<string, OpenBoard>();
  const reports: FetchReport[] = [];

  for (const { file, provider } of SUPPORTED) {
    let entries: unknown;
    try {
      entries = await fetchJson(`${BASE}/${file}`, userAgent);
    } catch (err) {
      // One unavailable file must not lose the other three.
      console.error(`  ${file}: ${err instanceof Error ? err.message : String(err)}`);
      reports.push({ provider, raw: 0, usable: 0 });
      continue;
    }
    if (!Array.isArray(entries)) {
      console.error(`  ${file}: unexpected shape, skipped`);
      reports.push({ provider, raw: 0, usable: 0 });
      continue;
    }

    let usable = 0;
    for (const raw of entries) {
      if (typeof raw !== 'string' || !raw.trim()) continue;

      const board =
        provider === 'workday'
          ? parseWorkday(raw)
          : { provider, token: raw.trim(), company: titleise(raw.trim()) };
      if (!board) continue;
      // Tokens are URL path segments; anything else is a parsing artefact.
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(board.token)) continue;

      const key =
        board.provider === 'workday'
          ? `workday:${board.token}:${board.extra?.site ?? ''}`
          : `${board.provider}:${board.token}`;
      if (seen.has(key)) continue;
      seen.set(key, board);
      usable++;
    }

    reports.push({ provider, raw: entries.length, usable });
    onProgress?.(file, usable);
  }

  return { boards: [...seen.values()], reports };
}
