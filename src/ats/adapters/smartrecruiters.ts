import { getJson } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

interface SmartRecruitersPosting {
  id: string;
  uuid?: string;
  name: string;
  jobAdId?: string;
  refNumber?: string;
  company?: { identifier?: string; name?: string };
  releasedDate?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
    remote?: boolean;
    hybrid?: boolean;
    fullLocation?: string;
  };
  department?: { label?: string };
  function?: { label?: string };
  industry?: { label?: string };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { label?: string };
  ref?: string;
}

const PAGE_SIZE = 100;

/**
 * SmartRecruiters — api.smartrecruiters.com/v1/companies/{token}/postings
 *
 * Paginated, and large tenants really are large (a single enterprise board
 * returned ~2,000 postings during verification), so this walks pages rather than
 * assuming one response holds the board. Descriptions live on a per-posting
 * endpoint and are fetched later, same as Workable. Verified live.
 */
export const smartRecruitersAdapter: AtsAdapter = {
  provider: 'smartrecruiters',
  endpointPattern: 'https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=100&offset={n}',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const out: NormalizedJob[] = [];
    let offset = 0;
    let totalFound = Infinity;

    while (offset < totalFound) {
      const url =
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.token)}/postings` +
        `?limit=${PAGE_SIZE}&offset=${offset}`;
      const page = await getJson<{ totalFound?: number; content?: SmartRecruitersPosting[] }>(
        url,
        'smartrecruiters',
        board.token,
        ctx,
      );

      const content = page.content ?? [];
      totalFound = page.totalFound ?? content.length;
      if (content.length === 0) break;

      for (const p of content) {
        const locationRaw =
          p.location?.fullLocation ??
          [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(', ');

        // SmartRecruiters exposes remote and hybrid as independent booleans;
        // hybrid wins because it is the more specific claim.
        const explicit = p.location?.hybrid ? 'hybrid' : p.location?.remote ? 'remote' : undefined;

        out.push({
          externalId: p.id,
          title: p.name,
          locationRaw: locationRaw || undefined,
          city: p.location?.city,
          region: p.location?.region,
          country: p.location?.country,
          department: p.department?.label,
          team: p.function?.label,
          employmentType: p.typeOfEmployment?.label,
          remoteType: inferRemoteType(explicit, locationRaw, p.name),
          seniority: inferSeniority(p.name, p.experienceLevel?.label),
          applyUrl: `https://jobs.smartrecruiters.com/${board.token}/${p.id}`,
          listingUrl: `https://jobs.smartrecruiters.com/${board.token}/${p.id}`,
          postedAt: parseDate(p.releasedDate),
          raw: p,
        });
      }

      offset += content.length;
      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
      // Defensive stop: a vendor that ignores offset would otherwise loop forever.
      if (content.length < PAGE_SIZE) break;
    }

    return out;
  },
};
