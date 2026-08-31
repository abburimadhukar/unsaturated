import { inferSeniority, parseDate, resolveRemoteType, stripHtml } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

/**
 * USAJobs — data.usajobs.gov/api/search
 *
 * Every US federal opening in one API. The most valuable single source for this
 * product's weakest family: HRIS work barely exists at tech startups but is
 * everywhere in government, which runs enormous HR, payroll and benefits
 * systems. Federal cloud and data roles are equally under-watched.
 *
 * Requires a free key from developer.usajobs.gov (instant, email-based). There
 * is no keyless route — only the codelist endpoints are open, and they carry no
 * postings.
 *
 * The board token selects a slice of the corpus rather than an employer:
 *   token 'all'          — everything, paged
 *   token '<keyword>'    — a keyword search, e.g. 'cloud'
 */

interface UsaJobsItem {
  MatchedObjectDescriptor?: {
    PositionTitle?: string;
    PositionURI?: string;
    ApplyURI?: string[];
    PositionLocationDisplay?: string;
    OrganizationName?: string;
    DepartmentName?: string;
    PositionSchedule?: { Name?: string }[];
    PositionOfferingType?: { Name?: string }[];
    PositionRemuneration?: {
      MinimumRange?: string;
      MaximumRange?: string;
      RateIntervalCode?: string;
    }[];
    PublicationStartDate?: string;
    UserArea?: {
      Details?: {
        JobSummary?: string;
        MajorDuties?: string[];
        Requirements?: string;
      };
    };
  };
}

const PAGE_SIZE = 500;

/** Federal pay is published per year, hour or "without compensation". */
function annualize(
  amount: string | undefined,
  interval: string | undefined,
): number | undefined {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const code = (interval ?? '').toUpperCase();
  if (code === 'PH') return Math.round(n * 2080); // per hour
  if (code === 'PD') return Math.round(n * 260); // per day
  if (code === 'PM') return Math.round(n * 12); // per month
  if (code === 'WC') return undefined; // without compensation
  return Math.round(n);
}

export const usajobsAdapter: AtsAdapter = {
  provider: 'usajobs',
  endpointPattern: 'https://data.usajobs.gov/api/search?ResultsPerPage=500&Page={n}',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const key = process.env.USAJOBS_API_KEY;
    const email = process.env.USAJOBS_EMAIL;
    if (!key || !email) {
      throw new AtsFetchError(
        'USAJOBS_API_KEY and USAJOBS_EMAIL are not set — get a free key at developer.usajobs.gov',
        'usajobs',
        board.token,
      );
    }

    const headers = {
      // USAJobs authenticates on all three; omitting any one returns 401.
      Host: 'data.usajobs.gov',
      'User-Agent': email,
      'Authorization-Key': key,
    };

    const out: NormalizedJob[] = [];
    const keyword = board.token === 'all' ? '' : board.token;
    const maxPages = ctx.maxJobs ? Math.ceil(ctx.maxJobs / PAGE_SIZE) : 6;

    for (let page = 1; page <= maxPages; page++) {
      const url =
        `https://data.usajobs.gov/api/search?ResultsPerPage=${PAGE_SIZE}&Page=${page}` +
        (keyword ? `&Keyword=${encodeURIComponent(keyword)}` : '');

      const res = await (ctx.fetchImpl ?? fetch)(url, {
        headers,
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
      if (!res.ok) {
        throw new AtsFetchError(`usajobs: HTTP ${res.status}`, 'usajobs', board.token, res.status);
      }

      const body = (await res.json()) as {
        SearchResult?: { SearchResultItems?: UsaJobsItem[]; SearchResultCountAll?: number };
      };
      const items = body.SearchResult?.SearchResultItems ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        const d = item.MatchedObjectDescriptor;
        if (!d?.PositionTitle) continue;

        const pay = d.PositionRemuneration?.[0];
        const details = d.UserArea?.Details;
        const description = stripHtml(
          [details?.JobSummary, (details?.MajorDuties ?? []).join(' '), details?.Requirements]
            .filter(Boolean)
            .join('\n\n'),
        );
        const locationRaw = d.PositionLocationDisplay;

        out.push({
          // PositionURI ends in the announcement number, which is stable.
          externalId: d.PositionURI ?? `${d.PositionTitle}-${d.OrganizationName}`,
          title: d.PositionTitle,
          descriptionText: description,
          locationRaw,
          // Federal postings are US-only by definition.
          country: 'US',
          department: d.DepartmentName ?? d.OrganizationName,
          employmentType: d.PositionSchedule?.[0]?.Name,
          remoteType: resolveRemoteType(undefined, locationRaw, d.PositionTitle),
          seniority: inferSeniority(d.PositionTitle),
          salaryMin: annualize(pay?.MinimumRange, pay?.RateIntervalCode),
          salaryMax: annualize(pay?.MaximumRange, pay?.RateIntervalCode),
          salaryCurrency: 'USD',
          applyUrl: d.ApplyURI?.[0] ?? d.PositionURI,
          listingUrl: d.PositionURI,
          postedAt: parseDate(d.PublicationStartDate),
          raw: d,
        });
      }

      if (items.length < PAGE_SIZE) break;
      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
    }

    return out;
  },
};
