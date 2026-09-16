import { getJson } from '../http.js';
import { inferSeniority, resolveRemoteType } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

/**
 * Eightfold — {tenant}.eightfold.ai/api/apply/v2/jobs?domain={domain}
 *
 * An AI talent platform used by large enterprises: Bayer, BCG, CoStar,
 * Faurecia, Freeport-McMoRan, Albemarle. Measured 16 September 2026 against 24
 * tenant/domain pairs read out of Common Crawl: 7 open, 11 gated, 6 not serving
 * this API — and 2,096 postings behind the 7 open ones, 299 per board, the
 * densest provider this project reads.
 *
 * ADDRESSING A BOARD
 *
 *   token        the tenant, the subdomain — "bayer"
 *   extra.domain the employer's own domain, which the API REQUIRES — "bayer.com"
 *   extra.site   the same domain, because it is also the board's identity
 *
 * A tenant can serve more than one domain (sandbox and staging microsites turn
 * up in the index), so the domain has to be part of what makes a row unique,
 * and `site` is the column the registry's unique index is built on. A wrong
 * domain answers 404, so it cannot be guessed; discovery reads it from the
 * archived URL, where Eightfold's own links carry it as `?domain=`.
 *
 * WHAT THE API DOES THAT A PAGINATOR MUST NOT ASSUME AWAY
 *
 * The page size is 10. Asking for 50, 100 or 500 returns 10, so a loop keyed on
 * the requested size would stop after one page and report a 601-posting board
 * as having ten. The loop advances by what came back.
 *
 * Gated tenants answer 403 with {"message": "Not authorized for PCSX"}. That is
 * a door held shut, not a board that is gone — the shared status mapping
 * already reads 403 as a refusal — and discovery never stores them because a
 * 403 is not a live verdict.
 *
 * The listing's job_description is an empty string. The body comes from the
 * per-posting endpoint, which describe.ts calls for postings already in scope.
 */

interface EightfoldPosition {
  id?: number | string;
  name?: string;
  posting_name?: string;
  location?: string;
  locations?: string[];
  department?: string;
  business_unit?: string;
  t_create?: number;
  t_update?: number;
  canonicalPositionUrl?: string;
  work_location_option?: string;
  location_flexibility?: string | null;
  job_description?: string;
}

interface EightfoldResponse {
  count?: number;
  positions?: EightfoldPosition[];
  branding?: { companyName?: string };
}

/** The vendor's own page size, measured — not a choice. */
export const EIGHTFOLD_PAGE = 10;

/**
 * An upper bound on pages for one board.
 *
 * At ten a page a large employer is a lot of requests: Bayer alone is 61. This
 * caps one board at 2,000 postings so a single tenant cannot hold a crawl shard
 * for minutes. The largest open tenant measured was 601.
 */
const MAX_PAGES = 200;

export function eightfoldDomain(extra: Record<string, string> | undefined): string | undefined {
  return extra?.domain ?? extra?.site;
}

/**
 * One page of a board, NEWEST FIRST — and the sort is not decoration.
 *
 * The crawl keeps at most 300 postings a board (DEFAULT_MAX_JOBS), so which 300
 * come back decides what the site shows. Eightfold's default order is stable
 * but only roughly by date: on Bayer, `sort_by=new` put a posting first that
 * the default order did not, one created three days after anything on its
 * first page. With the cap, the default would have dropped the freshest job on
 * the board — the one this product exists to surface. Measured 16 September
 * 2026: `sort_by=new` returns the same 601, stable across reads, strictly
 * newest-first, no repeats.
 */
export function eightfoldListUrl(tenant: string, domain: string, start: number, num: number): string {
  return (
    `https://${tenant}.eightfold.ai/api/apply/v2/jobs` +
    `?domain=${encodeURIComponent(domain)}&start=${start}&num=${num}&sort_by=new`
  );
}

export function eightfoldDetailUrl(tenant: string, domain: string, id: string): string {
  return `https://${tenant}.eightfold.ai/api/apply/v2/jobs/${encodeURIComponent(id)}?domain=${encodeURIComponent(domain)}`;
}

/** The posting's page on Eightfold, used when the employer publishes no URL of its own. */
function fallbackUrl(tenant: string, domain: string, id: string): string {
  return `https://${tenant}.eightfold.ai/careers/job/${encodeURIComponent(id)}?domain=${encodeURIComponent(domain)}`;
}

/** Eightfold's workplace field, which is more reliable than reading the location. */
function workplaceOf(p: EightfoldPosition): string | undefined {
  const v = (p.work_location_option ?? p.location_flexibility ?? '').toLowerCase();
  if (v.includes('remote')) return 'remote';
  if (v.includes('hybrid')) return 'hybrid';
  if (v.includes('onsite') || v.includes('on-site') || v.includes('on_site')) return 'on-site';
  return undefined;
}

/** The employer's own name, from the branding block every response carries. */
export function eightfoldCompanyFrom(body: unknown): string | undefined {
  const name = (body as EightfoldResponse | null)?.branding?.companyName?.trim();
  return name || undefined;
}

export const eightfoldAdapter: AtsAdapter = {
  provider: 'eightfold',
  endpointPattern: 'https://{tenant}.eightfold.ai/api/apply/v2/jobs?domain={domain}',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const domain = eightfoldDomain(board.extra);
    if (!domain) {
      throw new AtsFetchError(
        `eightfold/${board.token}: needs extra.domain — the API refuses without it`,
        'eightfold',
        board.token,
        undefined,
        'gone',
      );
    }

    const out: NormalizedJob[] = [];
    const seen = new Set<string>();
    let start = 0;
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && start < total; page++) {
      const body = await getJson<EightfoldResponse>(
        eightfoldListUrl(board.token, domain, start, EIGHTFOLD_PAGE),
        'eightfold',
        board.token,
        ctx,
      );
      if (!body || !Array.isArray(body.positions)) {
        if (page === 0) {
          throw new AtsFetchError(`eightfold/${board.token}: unexpected response shape`, 'eightfold', board.token);
        }
        break;
      }
      if (total === Infinity) total = typeof body.count === 'number' ? body.count : body.positions.length;
      if (body.positions.length === 0) break;

      let fresh = 0;
      for (const p of body.positions) {
        const id = p.id != null ? String(p.id) : undefined;
        const title = (p.name ?? p.posting_name ?? '').trim();
        if (!id || !title || seen.has(id)) continue;
        seen.add(id);
        fresh++;

        const locations = (p.locations ?? []).filter(Boolean);
        const locationRaw = (p.location ?? locations[0] ?? '').trim() || undefined;
        const url = p.canonicalPositionUrl || fallbackUrl(board.token, domain, id);

        out.push({
          externalId: id,
          title,
          locationRaw,
          remoteType: resolveRemoteType(workplaceOf(p), locationRaw, title, locations.join('; ')),
          department: p.department || p.business_unit || undefined,
          seniority: inferSeniority(title),
          // Epoch SECONDS. Multiplying is the whole conversion, and forgetting it
          // dates every posting to January 1970.
          postedAt: typeof p.t_create === 'number' ? new Date(p.t_create * 1000) : undefined,
          applyUrl: url,
          listingUrl: url,
          raw: p,
        });
      }

      // A page of nothing but repeats means the vendor is not advancing, and
      // asking again would read the same page until MAX_PAGES.
      if (fresh === 0) break;
      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
      start += body.positions.length;
    }

    return out;
  },
};
