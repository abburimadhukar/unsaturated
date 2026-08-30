import { getJson } from '../http.js';
import { inferSeniority, resolveRemoteType, stripHtml } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

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
    const [host, dataset] = board.token.split('|');
    if (!host || !dataset) return [];

    const out: NormalizedJob[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const url =
        `https://${host}/resource/${dataset}.json?$limit=${PAGE}&$offset=${offset}` +
        `&$order=posting_date DESC`;
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
          // Socrata exposes no per-posting apply URL, so link to the portal's
          // canonical job page rather than inventing one.
          applyUrl: r.job_id
            ? `https://${host}/resource/${dataset}.json?job_id=${encodeURIComponent(r.job_id)}`
            : undefined,
          postedAt: r.posting_date ? new Date(r.posting_date) : undefined,
          raw: r,
        });
      }

      if (rows.length < PAGE) break;
      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
    }

    return out;
  },
};
