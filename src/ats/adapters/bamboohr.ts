import { getJson } from '../http.js';
import { inferRemoteType, inferSeniority } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

/**
 * BambooHR — {token}.bamboohr.com/careers/list
 *
 * A single unpaginated JSON document per company: every open posting in one
 * response, no key and no paging. The listing carries no description, which is
 * normal here — several providers behave the same way, and the description
 * backfill fetches those separately for roles that look relevant.
 *
 * Worth having because of WHO uses it rather than how much it returns. BambooHR
 * is mid-market North America — companies of 50 to 500 people who never appear
 * on Greenhouse or Ashby. Roughly 3,281 such boards exist in the public web
 * archive, and the corpus held none of them.
 */

interface BambooLocation {
  city?: string | null;
  state?: string | null;
  country?: string | null;
  province?: string | null;
}

interface BambooJob {
  id: number | string;
  jobOpeningName?: string | null;
  departmentLabel?: string | null;
  employmentStatusLabel?: string | null;
  employmentType?: string | null;
  location?: BambooLocation | null;
  atsLocation?: BambooLocation | null;
  isRemote?: boolean | null;
  /** "0" on-site, "1" remote, "2" hybrid in the payloads seen so far. */
  locationType?: string | null;
}

interface BambooResponse {
  meta?: unknown;
  result?: BambooJob[];
}

/**
 * BambooHR splits a location across two objects and fills in whichever it has.
 *
 * `location` is what the company typed; `atsLocation` is the structured version,
 * and either can be entirely null. Joining the parts that exist beats picking
 * one and finding it empty.
 */
function locationOf(job: BambooJob): string | undefined {
  const parts = [
    job.location?.city ?? job.atsLocation?.city,
    job.location?.state ?? job.atsLocation?.state ?? job.atsLocation?.province,
    job.location?.country ?? job.atsLocation?.country,
  ].filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length === 0) return undefined;
  // Deduplicated: several boards repeat the state in both objects, which
  // produced "Texas, Texas" in the location column.
  return [...new Set(parts.map((p) => p.trim()))].join(', ');
}

export const bambooHrAdapter: AtsAdapter = {
  provider: 'bamboohr',
  endpointPattern: 'https://{token}.bamboohr.com/careers/list',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://${encodeURIComponent(board.token)}.bamboohr.com/careers/list`;
    const body = await getJson<BambooResponse>(url, 'bamboohr', board.token, ctx);
    const jobs = Array.isArray(body?.result) ? body.result : [];

    return jobs.flatMap((j): NormalizedJob[] => {
      const title = (j.jobOpeningName ?? '').trim();
      // A posting with no title cannot be classified, matched or displayed.
      // Storing it would put a blank row on the site.
      if (!title || j.id === undefined || j.id === null) return [];

      const locationRaw = locationOf(j);
      // locationType is the employer's own answer and beats guessing from the
      // location string; isRemote is the older flag and still set on some boards.
      const remote =
        j.locationType === '1' || j.isRemote === true
          ? 'fully_remote'
          : j.locationType === '2'
            ? 'hybrid'
            : inferRemoteType(locationRaw, title);

      const seniority = inferSeniority(title);
      const employment = j.employmentStatusLabel ?? j.employmentType ?? undefined;
      const department = j.departmentLabel ?? undefined;

      return [{
        externalId: String(j.id),
        title,
        ...(locationRaw ? { locationRaw } : {}),
        ...(remote ? { remoteType: remote } : {}),
        ...(employment ? { employmentType: employment } : {}),
        ...(department ? { department } : {}),
        ...(seniority ? { seniority } : {}),
        applyUrl: `https://${board.token}.bamboohr.com/careers/${j.id}`,
        listingUrl: `https://${board.token}.bamboohr.com/careers/${j.id}`,
        raw: j,
      }];
    });
  },
};
