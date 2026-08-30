import { getJson } from '../http.js';
import { inferSeniority, resolveRemoteType } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

interface RipplingJob {
  uuid?: string;
  name?: string;
  department?: { id?: string; label?: string };
  url?: string;
  workLocation?: { id?: string; label?: string };
}

/**
 * Rippling — api.rippling.com/platform/api/ats/v1/board/{token}/jobs
 *
 * The thinnest feed of any provider here: a title, a department, a location and
 * a URL. No publish date, no description, therefore no salary and no skill
 * fingerprint — these roles can only be classified from their title.
 *
 * Included anyway because the postings are real and Rippling's customers are
 * small companies that syndicate nowhere else. The cost is that they sort to the
 * bottom of a recency-ordered feed, since an unknown date cannot be ranked.
 */
export const ripplingAdapter: AtsAdapter = {
  provider: 'rippling',
  endpointPattern: 'https://api.rippling.com/platform/api/ats/v1/board/{token}/jobs',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(board.token)}/jobs`;
    const jobs = await getJson<RipplingJob[]>(url, 'rippling', board.token, ctx);
    if (!Array.isArray(jobs)) return [];

    return jobs.flatMap((job): NormalizedJob[] => {
      const title = job.name?.trim();
      if (!title) return [];

      // Rippling boards accumulate drafts named "Copy of …"; they are not real
      // openings and would otherwise appear as duplicates of the original.
      if (/^copy of\b/i.test(title)) return [];

      const locationRaw = job.workLocation?.label;
      return [
        {
          externalId: job.uuid ?? title,
          title,
          locationRaw,
          department: job.department?.label,
          remoteType: resolveRemoteType(undefined, locationRaw, title),
          seniority: inferSeniority(title),
          applyUrl: job.url,
          listingUrl: job.url,
          raw: job,
        },
      ];
    });
  },
};
