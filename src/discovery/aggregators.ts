/**
 * Harvests employer NAMES from public job APIs.
 *
 * None of these expose the employer's own ATS link — every one points back at
 * its own landing page — so they are useless as a token source and are never
 * used as a job source. What they do carry is company names, in volume, which
 * is exactly what the name-prober consumes.
 *
 * All six are free and keyless. Himalayas alone indexes ~102,000 jobs and The
 * Muse ~410,000, so paging deeper yields progressively more distinct employers.
 */

const UA = { 'user-agent': 'unsaturated-jobscout/0.1 (+https://github.com/abburimadhukar/unsaturated)' };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

interface Source {
  name: string;
  /** Page URLs to fetch, given how many pages the caller wants. */
  pages: (depth: number) => string[];
  /** Pulls company names out of one page's payload. */
  extract: (body: any) => (string | undefined)[];
}

const SOURCES: Source[] = [
  {
    name: 'themuse',
    pages: (d) => Array.from({ length: d }, (_, i) => `https://www.themuse.com/api/public/jobs?page=${i + 1}`),
    extract: (b) => (b?.results ?? []).map((j: any) => j?.company?.name),
  },
  {
    name: 'himalayas',
    pages: (d) => Array.from({ length: d }, (_, i) => `https://himalayas.app/jobs/api?limit=100&offset=${i * 100}`),
    extract: (b) => (b?.jobs ?? []).map((j: any) => j?.companyName),
  },
  {
    name: 'arbeitnow',
    pages: (d) => Array.from({ length: d }, (_, i) => `https://www.arbeitnow.com/api/job-board-api?page=${i + 1}`),
    extract: (b) => (b?.data ?? []).map((j: any) => j?.company_name),
  },
  {
    name: 'remotive',
    // Single endpoint; limit is the only knob.
    pages: () => ['https://remotive.com/api/remote-jobs?limit=1000'],
    extract: (b) => (b?.jobs ?? []).map((j: any) => j?.company_name),
  },
  {
    name: 'remoteok',
    pages: () => ['https://remoteok.com/api'],
    // First element is a legal notice, not a job.
    extract: (b) => (Array.isArray(b) ? b.slice(1) : []).map((j: any) => j?.company),
  },
  {
    name: 'jobicy',
    pages: () => ['https://jobicy.com/api/v2/remote-jobs?count=100'],
    extract: (b) => (b?.jobs ?? []).map((j: any) => j?.companyName),
  },
];

/**
 * Company names appear with suffixes and decorations that would break slug
 * generation ("Acme Corp - Remote", "Acme (Hiring!)").
 */
function tidy(raw: string): string | null {
  const name = raw
    .replace(/\s*[-–|]\s*(remote|hiring|careers?|jobs?).*$/i, '')
    .replace(/\s*\((hiring|remote|yc[^)]*)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 60) return null;
  // Placeholders that are not employers.
  if (/^(confidential|undisclosed|private|n\/a|various|multiple)$/i.test(name)) return null;
  return name;
}

export interface HarvestResult {
  bySource: Record<string, number>;
  names: string[];
}

export async function harvestCompanyNames(
  depth = 10,
  onProgress?: (source: string, found: number) => void,
): Promise<HarvestResult> {
  const all = new Set<string>();
  const bySource: Record<string, number> = {};

  for (const source of SOURCES) {
    const before = all.size;
    for (const url of source.pages(depth)) {
      const body = await getJson<any>(url);
      if (!body) continue;
      for (const raw of source.extract(body)) {
        if (typeof raw !== 'string') continue;
        const name = tidy(raw);
        if (name) all.add(name);
      }
    }
    bySource[source.name] = all.size - before;
    onProgress?.(source.name, all.size - before);
  }

  return { bySource, names: [...all] };
}
