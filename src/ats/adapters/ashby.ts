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
  compensation?: {
    scrapeableCompensationSalarySummary?: string;
    compensationTierSummary?: string;
  };
}

/**
 * Ashby publishes pay as a display string rather than numbers:
 * "€110K - €185K", "$150K – $200K", "£70,000 - £90,000".
 *
 * This is far better data than parsing prose out of a description, because the
 * employer entered it into a structured field — so it is exact, and it is
 * present on effectively every posting.
 */
function parseAshbyPay(
  summary: string | undefined,
): { min?: number; max?: number; currency?: string } | undefined {
  if (!summary) return undefined;

  const currency = summary.includes('€') ? 'EUR'
    : summary.includes('£') ? 'GBP'
    : summary.includes('$') ? 'USD'
    : undefined;

  const nums = [...summary.matchAll(/([\d,]+(?:\.\d+)?)\s*([KkMm])?/g)]
    .map((m) => {
      const base = Number((m[1] ?? '').replace(/,/g, ''));
      if (!Number.isFinite(base)) return NaN;
      const suffix = (m[2] ?? '').toLowerCase();
      return suffix === 'k' ? base * 1000 : suffix === 'm' ? base * 1_000_000 : base;
    })
    .filter((n) => Number.isFinite(n) && n >= 10_000 && n <= 2_000_000);

  if (nums.length === 0) return undefined;
  const min = Math.round(Math.min(...nums));
  const max = Math.round(Math.max(...nums));
  return currency ? { min, max, currency } : { min, max };
}

/**
 * Ashby — api.ashbyhq.com/posting-api/job-board/{token}
 *
 * Gives structured city/region/country plus an explicit isRemote flag, so its
 * location data needs the least cleanup of any provider here. Verified live.
 */
export const ashbyAdapter: AtsAdapter = {
  provider: 'ashby',
  endpointPattern: 'https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    // includeCompensation is opt-in and costs nothing; without it Ashby omits
    // the pay field entirely.
    const url =
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}` +
      '?includeCompensation=true';
    const body = await getJson<{ jobs?: AshbyJob[] }>(url, 'ashby', board.token, ctx);

    return (body.jobs ?? [])
      // Unlisted postings are drafts or internal-only; they are not applyable.
      .filter((job) => job.isListed !== false)
      .map((job): NormalizedJob => {
        const postal = job.address?.postalAddress;
        const secondary = job.secondaryLocations?.map((s) => s.location).filter(Boolean) as string[];
        const pay = parseAshbyPay(
          job.compensation?.scrapeableCompensationSalarySummary ??
            job.compensation?.compensationTierSummary,
        );
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
          salaryMin: pay?.min,
          salaryMax: pay?.max,
          salaryCurrency: pay?.currency,
          applyUrl: job.applyUrl ?? job.jobUrl,
          listingUrl: job.jobUrl,
          postedAt: parseDate(job.publishedAt),
          raw: job,
        };
      });
  },
};
