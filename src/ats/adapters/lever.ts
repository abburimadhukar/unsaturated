import { getJson } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate, stripHtml } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

interface LeverPosting {
  id: string;
  text: string;
  country?: string;
  workplaceType?: string;
  commitment?: string;
  categories?: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
    allLocations?: string[];
  };
  createdAt?: number;
  description?: string;
  descriptionPlain?: string;
  hostedUrl?: string;
  applyUrl?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

/**
 * Lever — api.lever.co/v0/postings/{token}?mode=json
 *
 * Returns the entire board in one array with full plain-text descriptions and a
 * structured salaryRange. `workplaceType` is authoritative, so no inference is
 * needed when it is present. Verified live.
 */
export const leverAdapter: AtsAdapter = {
  provider: 'lever',
  endpointPattern: 'https://api.lever.co/v0/postings/{token}?mode=json',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`;
    const postings = await getJson<LeverPosting[]>(url, 'lever', board.token, ctx);
    if (!Array.isArray(postings)) {
      // Lever reports several failure modes as a 200 carrying {"error": ...}.
      // Returning [] turned those into "no openings".
      throw new AtsFetchError(
        `lever/${board.token}: unexpected response shape`,
        'lever',
        board.token,
      );
    }

    return postings.map((p): NormalizedJob => {
      const locationRaw = p.categories?.location ?? p.categories?.allLocations?.join('; ');
      // Lever reports salary per interval; only annual figures are comparable.
      const annual = p.salaryRange?.interval === 'per-year-salary' || !p.salaryRange?.interval;

      return {
        externalId: p.id,
        title: p.text,
        descriptionHtml: p.description,
        descriptionText: p.descriptionPlain ?? stripHtml(p.description),
        locationRaw,
        country: p.country,
        department: p.categories?.department,
        team: p.categories?.team,
        employmentType: p.commitment ?? p.categories?.commitment,
        remoteType: inferRemoteType(p.workplaceType, locationRaw, p.text),
        seniority: inferSeniority(p.text),
        salaryMin: annual ? p.salaryRange?.min : undefined,
        salaryMax: annual ? p.salaryRange?.max : undefined,
        salaryCurrency: annual ? p.salaryRange?.currency : undefined,
        applyUrl: p.applyUrl ?? p.hostedUrl,
        listingUrl: p.hostedUrl,
        postedAt: parseDate(p.createdAt),
        raw: p,
      };
    });
  },
};
