import type { AtsProvider, BoardRef } from './types.js';

/**
 * Turns an apply URL into a board identity.
 *
 * This is how coverage bootstraps. Every apply URL in the wild leaks both its
 * ATS and that company's tenant token — jobs.lever.co/lyrahealth, ?gh_jid=,
 * apply.workable.com/nationsecurity. Harvest tokens once from any listing
 * source, then poll the ATS directly forever after and never depend on that
 * source for content again.
 *
 * Unsupported platforms are classified rather than discarded: knowing that 40%
 * of harvested URLs point at Workday is the input that decides what gets built
 * next, so "unknown" and "known but not yet ingestible" must stay distinct.
 */

export type IngestTier =
  /** Public JSON/XML endpoint, adapter implemented. */
  | 'supported'
  /** Structured endpoint exists but needs POST bodies or per-tenant discovery. */
  | 'json_api_unbuilt'
  /** No usable API; requires the browser tier. */
  | 'browser';

export interface KnownPlatform {
  platform: string;
  tier: IngestTier;
}

export type Resolution =
  | { status: 'supported'; board: BoardRef; platform: string }
  | { status: 'unsupported'; platform: string; tier: IngestTier; token?: string }
  | { status: 'unknown'; host: string };

type SupportedRule = {
  provider: AtsProvider;
  test: (url: URL) => string | undefined;
};

/** Path segment that is a real tenant token rather than a route keyword. */
function segment(url: URL, index: number): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  const value = parts[index];
  if (!value) return undefined;
  return decodeURIComponent(value);
}

function subdomain(url: URL, suffix: string): string | undefined {
  if (!url.hostname.endsWith(suffix)) return undefined;
  const label = url.hostname.slice(0, -suffix.length).replace(/\.$/, '');
  return label && label !== 'www' ? label : undefined;
}

const SUPPORTED_RULES: SupportedRule[] = [
  {
    provider: 'greenhouse',
    test: (url) => {
      if (/(^|\.)(boards|job-boards)\.greenhouse\.io$/.test(url.hostname)) return segment(url, 0);
      if (url.hostname === 'boards-api.greenhouse.io') return segment(url, 3); // /v1/boards/{token}/jobs
      return undefined;
    },
  },
  {
    provider: 'lever',
    test: (url) => {
      if (url.hostname === 'jobs.lever.co') return segment(url, 0);
      if (url.hostname === 'api.lever.co') return segment(url, 2); // /v0/postings/{token}
      return undefined;
    },
  },
  {
    provider: 'ashby',
    test: (url) => {
      if (url.hostname === 'jobs.ashbyhq.com') return segment(url, 0);
      if (url.hostname === 'api.ashbyhq.com') return segment(url, 2); // /posting-api/job-board/{token}
      return undefined;
    },
  },
  {
    provider: 'workable',
    test: (url) => {
      if (url.hostname === 'apply.workable.com') {
        const first = segment(url, 0);
        // /api/v1/widget/accounts/{token} vs /{token}/j/{code}
        return first === 'api' ? segment(url, 4) : first;
      }
      return undefined;
    },
  },
  {
    provider: 'smartrecruiters',
    test: (url) => {
      if (/(^|\.)(jobs|careers)\.smartrecruiters\.com$/.test(url.hostname)) return segment(url, 0);
      if (url.hostname === 'api.smartrecruiters.com') return segment(url, 2); // /v1/companies/{token}
      return undefined;
    },
  },
  { provider: 'breezy', test: (url) => subdomain(url, '.breezy.hr') },
  {
    provider: 'personio',
    test: (url) => subdomain(url, '.jobs.personio.de') ?? subdomain(url, '.jobs.personio.com'),
  },
];

/**
 * Platforms we can recognise but not yet ingest. The tier drives build order:
 * Workday alone is a large share of enterprise volume, and it is under-contested
 * precisely because it is unpleasant to automate.
 */
const KNOWN_UNSUPPORTED: { match: RegExp; platform: string; tier: IngestTier }[] = [
  { match: /\.myworkdayjobs\.com$|\.wd\d+\.myworkdayjobs\.com$/, platform: 'workday', tier: 'json_api_unbuilt' },
  { match: /\.oraclecloud\.com$/, platform: 'oracle_hcm', tier: 'json_api_unbuilt' },
  { match: /\.recruitee\.com$/, platform: 'recruitee', tier: 'json_api_unbuilt' },
  { match: /\.teamtailor\.com$/, platform: 'teamtailor', tier: 'json_api_unbuilt' },
  { match: /\.applytojob\.com$/, platform: 'jazzhr', tier: 'json_api_unbuilt' },
  { match: /(^|\.)ats\.rippling\.com$/, platform: 'rippling', tier: 'json_api_unbuilt' },
  { match: /\.bamboohr\.com$/, platform: 'bamboohr', tier: 'json_api_unbuilt' },
  { match: /(^|\.)comeet\.co$/, platform: 'comeet', tier: 'json_api_unbuilt' },
  { match: /\.icims\.com$/, platform: 'icims', tier: 'browser' },
  { match: /\.taleo\.net$/, platform: 'taleo', tier: 'browser' },
  { match: /successfactors\.(com|eu)$/, platform: 'successfactors', tier: 'browser' },
  { match: /(^|\.)recruiting\.paylocity\.com$/, platform: 'paylocity', tier: 'browser' },
  { match: /\.paycomonline\.net$/, platform: 'paycom', tier: 'browser' },
  { match: /(^|\.)ukg\.com$|\.ultipro\.com$/, platform: 'ukg', tier: 'browser' },
  { match: /workforcenow\.adp\.com$/, platform: 'adp', tier: 'browser' },
  { match: /\.dayforcehcm\.com$/, platform: 'dayforce', tier: 'browser' },
];

export function resolveApplyUrl(rawUrl: string): Resolution {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 'unknown', host: rawUrl };
  }

  for (const rule of SUPPORTED_RULES) {
    const token = rule.test(url);
    if (token) {
      return {
        status: 'supported',
        platform: rule.provider,
        board: { provider: rule.provider, token },
      };
    }
  }

  // A company-hosted careers page can still be Greenhouse or Lever underneath;
  // the query parameter gives away the platform but never the board token, so
  // these are reported as unsupported-with-known-platform pending a probe.
  if (url.searchParams.has('gh_jid') || url.searchParams.has('gh_src')) {
    return { status: 'unsupported', platform: 'greenhouse_embedded', tier: 'json_api_unbuilt' };
  }
  if (url.searchParams.has('lever-origin')) {
    return { status: 'unsupported', platform: 'lever_embedded', tier: 'json_api_unbuilt' };
  }

  for (const known of KNOWN_UNSUPPORTED) {
    if (known.match.test(url.hostname)) {
      return { status: 'unsupported', platform: known.platform, tier: known.tier };
    }
  }

  return { status: 'unknown', host: url.hostname };
}

/** Aggregates resolutions into the coverage map that drives build order. */
export function summarizeCoverage(urls: string[]): {
  total: number;
  supported: number;
  byPlatform: Record<string, { count: number; tier: IngestTier | 'unknown' }>;
  boards: BoardRef[];
} {
  const byPlatform: Record<string, { count: number; tier: IngestTier | 'unknown' }> = {};
  const seen = new Set<string>();
  const boards: BoardRef[] = [];
  let supported = 0;

  for (const raw of urls) {
    if (!raw) continue;
    const res = resolveApplyUrl(raw);
    const key =
      res.status === 'unknown' ? `unknown:${res.host}` : res.platform;
    const tier: IngestTier | 'unknown' =
      res.status === 'supported' ? 'supported' : res.status === 'unsupported' ? res.tier : 'unknown';

    byPlatform[key] ??= { count: 0, tier };
    byPlatform[key]!.count++;

    if (res.status === 'supported') {
      supported++;
      const dedupe = `${res.board.provider}:${res.board.token}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        boards.push(res.board);
      }
    }
  }

  return { total: urls.length, supported, byPlatform, boards };
}
