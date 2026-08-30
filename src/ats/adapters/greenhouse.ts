import { getJson } from '../http.js';
import { inferSeniority, parseDate, resolveRemoteType, stripHtml } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

interface GreenhouseJob {
  id: number;
  internal_job_id?: number;
  title: string;
  updated_at?: string;
  first_published?: string;
  requisition_id?: string;
  absolute_url?: string;
  location?: { name?: string };
  content?: string;
  metadata?: { name?: string; value?: unknown }[] | null;
  departments?: { name?: string }[];
  offices?: { name?: string; location?: string }[];
}

/**
 * Greenhouse — boards-api.greenhouse.io/v1/boards/{token}/jobs
 *
 * `content=true` returns the full HTML description in the same call, so there is
 * no per-job fanout. Verified live against a public board.
 */
export const greenhouseAdapter: AtsAdapter = {
  provider: 'greenhouse',
  endpointPattern: 'https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs?content=true`;
    const body = await getJson<{ jobs?: GreenhouseJob[] }>(url, 'greenhouse', board.token, ctx);

    return (body.jobs ?? []).map((job): NormalizedJob => {
      // offices[].location is a full "City, Region, Country" string where
      // location.name is often just an office nickname ("Office - London"),
      // which country inference cannot read.
      const officeLocation = job.offices?.find((o) => o.location)?.location;
      const locationRaw = officeLocation ?? job.location?.name;
      return {
        externalId: String(job.id),
        title: job.title,
        descriptionHtml: job.content,
        descriptionText: stripHtml(job.content),
        locationRaw,
        department: job.departments?.[0]?.name,
        remoteType: resolveRemoteType(undefined, locationRaw, job.title),
        seniority: inferSeniority(job.title),
        applyUrl: job.absolute_url,
        listingUrl: job.absolute_url,
        // first_published is the true posting date; updated_at only backstops it.
        postedAt: parseDate(job.first_published) ?? parseDate(job.updated_at),
        raw: job,
      };
    });
  },
};
