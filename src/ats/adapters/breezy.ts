import { getJson } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate, stripHtml } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

/** Breezy returns some location fields as either a bare string or {name}. */
type NameOrString = string | { name?: string } | undefined;

interface BreezyJob {
  id?: string;
  _id?: string;
  friendly_id?: string;
  name: string;
  url?: string;
  published_date?: string;
  type?: { id?: string; name?: string };
  location?: {
    country?: NameOrString;
    state?: NameOrString;
    city?: string;
    is_remote?: boolean;
    name?: string;
  };
  department?: string;
  description?: string;
  salary?: unknown;
  company?: { name?: string; friendly_id?: string };
}

function label(value: NameOrString): string | undefined {
  if (typeof value === 'string') return value || undefined;
  return value?.name || undefined;
}

/**
 * Breezy — {token}.breezy.hr/json
 *
 * Small-company heavy, which makes it disproportionately useful here: these are
 * exactly the boards that never syndicate to aggregators and therefore score
 * high on discovery friction. Verified live.
 *
 * The board feed carries no description field (confirmed against a live tenant);
 * text needs a per-job follow-up, deferred to scoring like Workable.
 */
export const breezyAdapter: AtsAdapter = {
  provider: 'breezy',
  endpointPattern: 'https://{token}.breezy.hr/json',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://${encodeURIComponent(board.token)}.breezy.hr/json`;
    const jobs = await getJson<BreezyJob[]>(url, 'breezy', board.token, ctx);
    if (!Array.isArray(jobs)) {
      throw new AtsFetchError(
        `breezy/${board.token}: unexpected response shape`,
        'breezy',
        board.token,
      );
    }

    return jobs.map((job): NormalizedJob => {
      const externalId = job.id ?? job._id ?? job.friendly_id ?? job.name;
      const country = label(job.location?.country);
      const region = label(job.location?.state);
      const locationRaw =
        job.location?.name ?? [job.location?.city, region, country].filter(Boolean).join(', ');
      const listingUrl =
        job.url ??
        (job.friendly_id ? `https://${board.token}.breezy.hr/p/${job.friendly_id}` : undefined);

      return {
        externalId: String(externalId),
        title: job.name,
        descriptionHtml: job.description,
        descriptionText: stripHtml(job.description),
        locationRaw: locationRaw || undefined,
        city: job.location?.city,
        region,
        country,
        department: job.department,
        employmentType: job.type?.name,
        remoteType: inferRemoteType(job.location?.is_remote, locationRaw, job.name),
        seniority: inferSeniority(job.name),
        applyUrl: listingUrl,
        listingUrl,
        postedAt: parseDate(job.published_date),
        raw: job,
      };
    });
  },
};
