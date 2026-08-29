import { getJson } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

interface WorkableJob {
  title: string;
  shortcode: string;
  code?: string;
  employment_type?: string;
  telecommuting?: boolean;
  department?: string;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string;
  city?: string;
  state?: string;
  education?: string;
  experience?: string;
  function?: string;
  industry?: string;
  locations?: { country?: string; city?: string; region?: string }[];
}

/**
 * Workable — apply.workable.com/api/v1/widget/accounts/{token}
 *
 * Note: this endpoint is listing-only — it carries no job description. The text
 * needs a per-job follow-up call, which is deliberately deferred to the scoring
 * stage so a full crawl does not fan out to one request per posting. Everything
 * the saturation model needs at ingest time (published_on, telecommuting,
 * location) is already here. Verified live.
 */
export const workableAdapter: AtsAdapter = {
  provider: 'workable',
  endpointPattern: 'https://apply.workable.com/api/v1/widget/accounts/{token}',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board.token)}`;
    const body = await getJson<{ jobs?: WorkableJob[] }>(url, 'workable', board.token, ctx);

    return (body.jobs ?? []).map((job): NormalizedJob => {
      const locationRaw = [job.city, job.state, job.country].filter(Boolean).join(', ');

      return {
        externalId: job.shortcode,
        title: job.title,
        locationRaw: locationRaw || undefined,
        city: job.city,
        region: job.state,
        country: job.country,
        department: job.department,
        employmentType: job.employment_type,
        remoteType: inferRemoteType(job.telecommuting, locationRaw, job.title),
        seniority: inferSeniority(job.title, job.experience),
        applyUrl: job.application_url ?? job.shortlink ?? job.url,
        listingUrl: job.url ?? job.shortlink,
        postedAt: parseDate(job.published_on) ?? parseDate(job.created_at),
        raw: job,
      };
    });
  },
};
