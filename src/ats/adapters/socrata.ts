import { getJson } from '../http.js';
import { inferSeniority, parseDate, resolveRemoteType, stripHtml } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

/**
 * Socrata open-data job portals — municipal and state government postings.
 *
 * Cities publish their vacancies as open data on Socrata, with full
 * descriptions, real salary bands and posting dates, and no key of any kind.
 * That makes them the only government source reachable without credentials,
 * and public-sector employers are where HRIS, payroll and benefits-systems
 * roles actually live.
 *
 * The board token is "{host}|{datasetId}", because one adapter serves every
 * portal that follows the standard NYC-style schema.
 */

interface SocrataRow {
  job_id?: string;
  business_title?: string;
  civil_service_title?: string;
  agency?: string;
  job_category?: string;
  career_level?: string;
  full_time_part_time_indicator?: string;
  salary_range_from?: string;
  salary_range_to?: string;
  salary_frequency?: string;
  work_location?: string;
  job_description?: string;
  minimum_qual_requirements?: string;
  posting_date?: string;
  posting_type?: string;
}

const PAGE = 1000;

/**
 * Human-facing portal for a Socrata host.
 *
 * The apply link used to point at the dataset's JSON row
 * (…/resource/kpav-sd4t.json?job_id=771431), which is an API response, not a
 * page anyone can apply on — a dead end on 1,453 NYC postings. Where the portal
 * is known the link goes there; otherwise it falls back to the dataset's own
 * human view rather than inventing one.
 */
const PORTALS: Record<string, (jobId: string) => string> = {
  'data.cityofnewyork.us': (id) =>
    `https://cityjobs.nyc.gov/jobs?keywords=${encodeURIComponent(id)}`,
};

/** Portals publish pay per Annum, Hourly or Daily. */
function annualize(raw: string | undefined, frequency: string | undefined): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const f = (frequency ?? '').toLowerCase();
  if (f.startsWith('hour')) return Math.round(n * 2080);
  if (f.startsWith('dai')) return Math.round(n * 260);
  return Math.round(n);
}

export const socrataAdapter: AtsAdapter = {
  provider: 'socrata',
  endpointPattern: 'https://{host}/resource/{dataset}.json',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const applyLink = (host: string, dataset: string, jobId: string | undefined) => {
      const portal = PORTALS[host];
      if (portal && jobId) return portal(jobId);
      return `https://${host}/d/${dataset}`;
    };
    const [host, dataset] = board.token.split('|');
    if (!host || !dataset) {
      // A token missing its "|" separator silently yielded zero jobs and no
      // error, so the board read as healthy-and-empty indefinitely.
      throw new AtsFetchError(
        `socrata/${board.token}: token must be "host|dataset"`,
        'socrata',
        board.token,
      );
    }

    const out: NormalizedJob[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const url =
        `https://${host}/resource/${dataset}.json?$limit=${PAGE}&$offset=${offset}` +
        // Ordered by :id, the row identifier, because it is unique. Paging over
        // a non-unique sort (posting_date) is unstable in SoQL and was both
        // duplicating and skipping rows across the offset boundary — a live
        // crawl returned 1,453 rows carrying only 1,441 distinct job ids.
        `&$order=:id`;
      const rows = await getJson<SocrataRow[]>(url, 'socrata', board.token, ctx);
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const r of rows) {
        const title = r.business_title ?? r.civil_service_title;
        if (!title) continue;

        // "Internal" postings are open only to existing employees.
        if ((r.posting_type ?? '').toLowerCase() === 'internal') continue;

        const description = stripHtml(
          [r.job_description, r.minimum_qual_requirements].filter(Boolean).join('\n\n'),
        );
        const locationRaw = r.work_location;

        out.push({
          externalId: r.job_id ?? `${title}-${r.agency ?? host}`,
          title,
          descriptionText: description,
          locationRaw,
          department: r.agency,
          employmentType: r.full_time_part_time_indicator === 'P' ? 'Part-time' : 'Full-time',
          remoteType: resolveRemoteType(undefined, locationRaw, title),
          seniority: inferSeniority(title, r.career_level),
          salaryMin: annualize(r.salary_range_from, r.salary_frequency),
          salaryMax: annualize(r.salary_range_to, r.salary_frequency),
          salaryCurrency: 'USD',
          applyUrl: applyLink(host, dataset, r.job_id),
          listingUrl: applyLink(host, dataset, r.job_id),
          postedAt: parseDate(r.posting_date),
          raw: r,
        });
      }

      if (rows.length < PAGE) break;
      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
    }

    return out;
  },
};
