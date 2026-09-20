/** Public-source leads, never a claim that a result is the hiring manager. */
export interface ResearchLane {
  id: 'team' | 'recruiting' | 'signals';
  label: string;
  query: string;
  searchUrl: string;
}

export interface SourceLead {
  title: string;
  url: string;
  description: string;
}

export interface ResearchGroup extends ResearchLane {
  leads: SourceLead[];
  unavailable?: boolean;
}

const MAX_QUERY_PART = 100;

function quoted(value: string): string {
  // Keep one human-readable phrase, not a pile of search operators from a job row.
  const plain = value.replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_PART);
  return `"${plain}"`;
}

export function researchLanes(company: string, title: string): ResearchLane[] {
  const co = quoted(company);
  const role = quoted(title);
  const lanes = [
    { id: 'team' as const, label: 'Potential team leaders', query: `${co} ${role} manager director site:linkedin.com/in` },
    { id: 'recruiting' as const, label: 'Recruiting contacts', query: `${co} recruiter talent acquisition site:linkedin.com/in` },
    { id: 'signals' as const, label: 'Company and team context', query: `${co} ${role} team engineering blog careers` },
  ];
  return lanes.map((lane) => ({
    ...lane,
    searchUrl: `https://search.brave.com/search?q=${encodeURIComponent(lane.query)}`,
  }));
}

function safeResult(value: unknown): SourceLead | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.title !== 'string' || typeof row.url !== 'string') return null;
  let url: URL;
  try { url = new URL(row.url); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return {
    title: row.title.trim().slice(0, 180),
    url: url.toString(),
    description: typeof row.description === 'string' ? row.description.trim().slice(0, 320) : '',
  };
}

export function parseBraveResults(payload: unknown): SourceLead[] {
  if (!payload || typeof payload !== 'object') return [];
  const web = (payload as { web?: unknown }).web;
  if (!web || typeof web !== 'object') return [];
  const rows = (web as { results?: unknown }).results;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const leads: SourceLead[] = [];
  for (const row of rows) {
    const lead = safeResult(row);
    if (!lead || seen.has(lead.url)) continue;
    seen.add(lead.url);
    leads.push(lead);
    if (leads.length >= 5) break;
  }
  return leads;
}

export async function searchPublicSources(
  company: string,
  title: string,
  apiKey: string,
  doFetch: typeof fetch = fetch,
): Promise<ResearchGroup[]> {
  const lanes = researchLanes(company, title);
  return Promise.all(lanes.map(async (lane): Promise<ResearchGroup> => {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', lane.query);
    url.searchParams.set('count', '5');
    try {
      const response = await doFetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      });
      if (!response.ok) return { ...lane, leads: [], unavailable: true };
      return { ...lane, leads: parseBraveResults(await response.json()) };
    } catch {
      return { ...lane, leads: [], unavailable: true };
    }
  }));
}
