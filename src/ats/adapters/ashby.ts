import { getJson } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate, stripHtml } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  address?: {
    postalAddress?: {
      addressLocality?: string;
      addressRegion?: string;
      addressCountry?: string;
    };
  };
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
}

/**
 * Ashby — api.ashbyhq.com/posting-api/job-board/{token}
 *
 * Gives structured city/region/country plus an explicit isRemote flag, so its
 * location data needs the least cleanup of any provider here. Verified live.
 */
export const ashbyAdapter: AtsAdapter = {
  provider: 'ashby',
  endpointPattern: 'https://api.ashbyhq.com/posting-api/job-board/{token}',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}`;
    const body = await getJson<{ jobs?: AshbyJob[] }>(url, 'ashby', board.token, ctx);

    return (body.jobs ?? [])
      // Unlisted postings are drafts or internal-only; they are not applyable.
      .filter((job) => job.isListed !== false)
      .map((job): NormalizedJob => {
        const postal = job.address?.postalAddress;
        const secondary = job.secondaryLocations?.map((s) => s.location).filter(Boolean) as string[];
        const locationRaw = [job.location, ...(secondary ?? [])].filter(Boolean).join('; ');

        return {
          externalId: job.id,
          title: job.title,
          descriptionHtml: job.descriptionHtml,
          descriptionText: job.descriptionPlain ?? stripHtml(job.descriptionHtml),
          locationRaw: locationRaw || undefined,
          city: postal?.addressLocality,
          region: postal?.addressRegion,
          country: postal?.addressCountry,
          department: job.department,
          team: job.team,
          employmentType: job.employmentType,
          remoteType: inferRemoteType(job.workplaceType ?? job.isRemote, locationRaw, job.title),
          seniority: inferSeniority(job.title),
          applyUrl: job.applyUrl ?? job.jobUrl,
          listingUrl: job.jobUrl,
          postedAt: parseDate(job.publishedAt),
          raw: job,
        };
      });
  },
};
