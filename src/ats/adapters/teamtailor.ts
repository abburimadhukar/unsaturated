import { getJson } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate, stripHtml } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

/**
 * Teamtailor — {token}.teamtailor.com/jobs.json
 *
 * A JSON Feed, which is a blogging format rather than a jobs one: every item
 * carries a title, a link, a date and a body of HTML, and nothing else. The
 * useful structure hides in `_jobposting`, a schema.org JobPosting the employer
 * fills in to whatever degree they bother.
 *
 * So this reads the structured block where it exists and the feed item where it
 * does not, rather than trusting either alone. Roughly 870 boards in the public
 * web archive, Nordic and European-heavy.
 */

interface SchemaPlace {
  address?: {
    addressLocality?: string | null;
    addressRegion?: string | null;
    addressCountry?: string | { name?: string | null } | null;
  } | null;
}

interface SchemaJobPosting {
  title?: string | null;
  description?: string | null;
  datePosted?: string | null;
  employmentType?: string | string[] | null;
  jobLocation?: SchemaPlace | SchemaPlace[] | null;
  /** Present on remote roles as a JobPosting extension. */
  jobLocationType?: string | null;
  hiringOrganization?: { name?: string | null } | null;
}

interface FeedItem {
  id?: string;
  title?: string | null;
  url?: string | null;
  date_published?: string | null;
  content_html?: string | null;
  _jobposting?: SchemaJobPosting | null;
}

interface JsonFeed {
  items?: FeedItem[];
}

function countryName(c: SchemaPlace['address'] extends infer A ? A : never): string | undefined {
  const raw = c?.addressCountry;
  if (!raw) return undefined;
  return typeof raw === 'string' ? raw : (raw.name ?? undefined);
}

function locationOf(posting: SchemaJobPosting | null | undefined): string | undefined {
  if (!posting?.jobLocation) return undefined;
  // schema.org allows one place or several; a role listed in three cities is
  // one posting, so the first is the one that names it.
  const place = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
  const a = place?.address;
  if (!a) return undefined;
  const parts = [a.addressLocality, a.addressRegion, countryName(a)]
    .filter((p): p is string => Boolean(p && String(p).trim()))
    .map((p) => String(p).trim());
  if (parts.length === 0) return undefined;
  return [...new Set(parts)].join(', ');
}

/** schema.org uses FULL_TIME / PART_TIME / CONTRACTOR / INTERN. */
function employmentOf(value: string | string[] | null | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return undefined;
  const v = first.toUpperCase();
  if (v.includes('FULL')) return 'Full-time';
  if (v.includes('PART')) return 'Part-time';
  if (v.includes('CONTRACT') || v.includes('TEMPORARY')) return 'Contract';
  if (v.includes('INTERN')) return 'Internship';
  return undefined;
}

export const teamtailorAdapter: AtsAdapter = {
  provider: 'teamtailor',
  endpointPattern: 'https://{token}.teamtailor.com/jobs.json',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const url = `https://${encodeURIComponent(board.token)}.teamtailor.com/jobs.json`;
    const body = await getJson<JsonFeed>(url, 'teamtailor', board.token, ctx);
    const items = Array.isArray(body?.items) ? body.items : [];

    return items.flatMap((item): NormalizedJob[] => {
      const posting = item._jobposting ?? null;
      const title = (item.title ?? posting?.title ?? '').trim();
      if (!title) return [];

      // The feed id is a uuid and the only stable identifier here — the URL
      // carries a slug that changes when a title is edited.
      const id = item.id ?? item.url ?? undefined;
      if (!id) return [];

      const locationRaw = locationOf(posting);
      const remote =
        posting?.jobLocationType === 'TELECOMMUTE'
          ? 'fully_remote'
          : inferRemoteType(locationRaw, title);
      const descriptionText = stripHtml(item.content_html ?? posting?.description ?? '');
      const posted = parseDate(item.date_published ?? posting?.datePosted ?? undefined);
      const employment = employmentOf(posting?.employmentType);
      const seniority = inferSeniority(title);

      return [{
        externalId: String(id),
        title,
        ...(locationRaw ? { locationRaw } : {}),
        ...(remote ? { remoteType: remote } : {}),
        ...(employment ? { employmentType: employment } : {}),
        ...(seniority ? { seniority } : {}),
        ...(posted ? { postedAt: posted } : {}),
        ...(descriptionText ? { descriptionText } : {}),
        ...(item.url ? { applyUrl: item.url, listingUrl: item.url } : {}),
        raw: item,
      }];
    });
  },
};
