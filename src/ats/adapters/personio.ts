import { XMLParser } from 'fast-xml-parser';
import { getText } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate, stripHtml } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

interface PersonioDescription {
  name?: string;
  value?: string;
}

interface PersonioPosition {
  id?: string | number;
  subcompany?: string;
  office?: string;
  additionalOffices?: { office?: string | string[] } | string;
  department?: string;
  recruitingCategory?: string;
  name?: string;
  jobDescriptions?: { jobDescription?: PersonioDescription | PersonioDescription[] };
  employmentType?: string;
  seniority?: string;
  schedule?: string;
  yearsOfExperience?: string;
  occupation?: string;
  occupationCategory?: string;
  createdAt?: string;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  // Force these to arrays so a board with exactly one position parses the same
  // way as a board with fifty.
  isArray: (name) => name === 'position' || name === 'jobDescription',
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Personio — {token}.jobs.personio.de/xml
 *
 * The only verified provider that hands over `seniority` and `yearsOfExperience`
 * as first-class fields rather than burying them in prose, which makes it the
 * cheapest source for the qualification-friction axis. EU-heavy. Verified live.
 *
 * <jobDescriptions> is optional and ships empty on some tenants, so description
 * coverage varies by board rather than being guaranteed.
 */
export const personioAdapter: AtsAdapter = {
  provider: 'personio',
  endpointPattern: 'https://{token}.jobs.personio.de/xml',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    // Some tenants are provisioned on .com rather than .de.
    const domain = board.extra?.domain ?? 'jobs.personio.de';
    const url = `https://${encodeURIComponent(board.token)}.${domain}/xml`;
    const xml = await getText(url, 'personio', board.token, ctx);

    const parsed = parser.parse(xml) as Record<string, { position?: PersonioPosition[] }>;
    const root = parsed['workzag-jobs'] ?? Object.values(parsed)[0];
    const positions = toArray(root?.position);

    return positions.flatMap((p): NormalizedJob[] => {
      if (!p.name || p.id === undefined) return [];

      const sections = toArray(p.jobDescriptions?.jobDescription);
      const descriptionHtml = sections
        .map((s) => (s.name ? `<h3>${s.name}</h3>${s.value ?? ''}` : (s.value ?? '')))
        .join('\n');

      const offices = toArray(
        typeof p.additionalOffices === 'object' ? p.additionalOffices?.office : undefined,
      );
      const locationRaw = [p.office, ...offices].filter(Boolean).join('; ');
      const descriptionText = stripHtml(descriptionHtml);

      return [
        {
          externalId: String(p.id),
          title: p.name,
          descriptionHtml: descriptionHtml || undefined,
          descriptionText,
          locationRaw: locationRaw || undefined,
          city: p.office,
          department: p.department,
          employmentType: [p.employmentType, p.schedule].filter(Boolean).join(' / ') || undefined,
          remoteType: inferRemoteType(undefined, locationRaw, p.name, descriptionText),
          seniority: inferSeniority(p.name, p.seniority),
          applyUrl: `https://${board.token}.${domain}/job/${p.id}`,
          listingUrl: `https://${board.token}.${domain}/job/${p.id}`,
          postedAt: parseDate(p.createdAt),
          raw: p,
        },
      ];
    });
  },
};
