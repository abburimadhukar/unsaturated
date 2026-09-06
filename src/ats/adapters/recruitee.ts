import { getJson } from '../http.js';
import { inferSeniority, parseDate, stripHtml } from '../normalize.js';
import type { AtsAdapter, NormalizedJob, RemoteType } from '../types.js';

/**
 * Recruitee — {token}.recruitee.com/api/offers/
 *
 * One unpaginated JSON document, and the richest listing of any provider here:
 * title, city, country, department, employment type, publish date, seniority
 * band AND the full description all arrive in the first response. Nothing needs
 * a second request, so these boards cost one call each and still produce jobs
 * with descriptions — which is what the skill match and the family classifier
 * both want.
 *
 * European-heavy, mid-market. Roughly 553 boards in the public web archive.
 */

interface RecruiteeOffer {
  id?: number | string;
  slug?: string | null;
  title?: string | null;
  /** on_site / hybrid / remote are separate booleans, not one field. */
  remote?: boolean | null;
  hybrid?: boolean | null;
  on_site?: boolean | null;
  city?: string | null;
  state_name?: string | null;
  country?: string | null;
  country_code?: string | null;
  department?: string | null;
  employment_type_code?: string | null;
  experience_code?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  careers_url?: string | null;
  careers_apply_url?: string | null;
  description?: string | null;
  requirements?: string | null;
  status?: string | null;
}

interface RecruiteeResponse {
  offers?: RecruiteeOffer[];
}

/** 'fulltime_permanent' and friends read badly on a job card. */
function employmentOf(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.toLowerCase();
  if (c.includes('intern')) return 'Internship';
  if (c.includes('temp') || c.includes('contract') || c.includes('freelance')) return 'Contract';
  if (c.includes('parttime') || c.includes('part_time')) return 'Part-time';
  if (c.includes('fulltime') || c.includes('full_time')) return 'Full-time';
  return undefined;
}

/**
 * Recruitee states the arrangement in three booleans rather than one field, and
 * an employer can leave all three false. Trusting them beats reading the
 * location string, which is why they are checked before anything is inferred.
 */
function remoteOf(o: RecruiteeOffer): RemoteType | undefined {
  if (o.remote === true) return 'fully_remote';
  if (o.hybrid === true) return 'hybrid';
  if (o.on_site === true) return 'on_site';
  return undefined;
}

export const recruiteeAdapter: AtsAdapter = {
  provider: 'recruitee',
  endpointPattern: 'https://{token}.recruitee.com/api/offers/',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://${encodeURIComponent(board.token)}.recruitee.com/api/offers/`;
    const body = await getJson<RecruiteeResponse>(url, 'recruitee', board.token, ctx);
    const offers = Array.isArray(body?.offers) ? body.offers : [];

    return offers.flatMap((o): NormalizedJob[] => {
      const title = (o.title ?? '').trim();
      if (!title || o.id === undefined || o.id === null) return [];
      // A closed offer is still listed. Storing it would put a role on the site
      // that cannot be applied for.
      if (o.status && o.status.toLowerCase() !== 'published') return [];

      const locationRaw = [o.city, o.state_name, o.country]
        .filter((p): p is string => Boolean(p && p.trim()))
        .map((p) => p.trim())
        .filter((p, i, a) => a.indexOf(p) === i)
        .join(', ');

      // Description and requirements are separate fields and both matter: the
      // classifier and the resume match read whatever text is available.
      const descriptionText = stripHtml(
        [o.description ?? '', o.requirements ?? ''].filter(Boolean).join('\n\n'),
      );
      const posted = parseDate(o.published_at ?? o.created_at ?? undefined);
      const employment = employmentOf(o.employment_type_code);
      const remote = remoteOf(o);
      // The employer's own band beats guessing from the title.
      const seniority = o.experience_code?.replace(/_/g, ' ') || inferSeniority(title);
      const apply = o.careers_apply_url ?? o.careers_url ?? undefined;

      return [{
        externalId: String(o.id),
        title,
        ...(locationRaw ? { locationRaw } : {}),
        ...(o.country_code ? { country: o.country_code } : {}),
        ...(remote ? { remoteType: remote } : {}),
        ...(employment ? { employmentType: employment } : {}),
        ...(o.department ? { department: o.department } : {}),
        ...(seniority ? { seniority } : {}),
        ...(posted ? { postedAt: posted } : {}),
        ...(descriptionText ? { descriptionText } : {}),
        ...(apply ? { applyUrl: apply } : {}),
        ...(o.careers_url ? { listingUrl: o.careers_url } : {}),
        raw: o,
      }];
    });
  },
};
