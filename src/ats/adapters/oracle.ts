import { getJson } from '../http.js';
import { inferSeniority, parseDate, resolveRemoteType } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

/**
 * Oracle Cloud Recruiting (Oracle HCM "Candidate Experience").
 *
 *   POST-less GET {host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *
 * The largest hiring system this project had not connected. Measured 15 Sep
 * 2026 against CC-MAIN-2026-34: 744 tenant/site pairs across 522 hosts on two
 * of three index pages, and 14 of 14 sampled tenants answered clean JSON with
 * no key, no token and no session — 1,865 open postings behind those fourteen.
 *
 * WHY IT MATTERS MORE THAN ITS BOARD COUNT SUGGESTS
 *
 * Oracle's customers are hospitals, universities, utilities, government and
 * large European manufacturers. The sampled boards averaged 133 postings each
 * against Workday's 6.7 and Greenhouse's 2.4, and they are exactly the
 * employers the Institutions page exists to surface — Pearson, Amplifon,
 * Parkland Hospital, Daher. Almost nobody in the cloud job-seeking crowd is
 * watching them.
 *
 * ADDRESSING A BOARD
 *
 * Two identifiers, like Workday and UKG, and neither works alone:
 *
 *   token       the tenant, which is the host's first label — "hccz" is Pearson
 *   extra.host  the full pod host, e.g. hccz.fa.em3.oraclecloud.com
 *   extra.site  the siteNumber, e.g. CX or CX_1 or fabCareers
 *
 * The tenant codes are opaque four-letter strings, so the employer's real name
 * cannot be derived from the token the way it can for greenhouse/stripe. It
 * comes back in `organizationsFacet` instead, which is why the request asks for
 * that expansion and why verify.ts reads it — see the `company` field there.
 *
 * NO DESCRIPTIONS IN THE LISTING
 *
 * ShortDescriptionStr is empty on every posting sampled and the description
 * fields are null, so this is a listing-only provider like Workday and
 * SmartRecruiters: describe.ts fetches the body per posting for jobs already
 * judged in scope.
 */

interface OracleRequisition {
  Id?: string;
  Title?: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  WorkplaceType?: string;
  WorkplaceTypeCode?: string;
  JobFamily?: string | null;
  JobFunction?: string | null;
  Department?: string | null;
  Organization?: string | null;
  ShortDescriptionStr?: string;
  secondaryLocations?: { Name?: string }[];
}

interface OracleSearch {
  TotalJobsCount?: number;
  requisitionList?: OracleRequisition[];
  organizationsFacet?: { Name?: string }[];
}

interface OracleResponse {
  items?: OracleSearch[];
}

/**
 * The server's own ceiling, not ours.
 *
 * Asking for 300 returns 200. Sending a limit the vendor silently truncates is
 * how a paginator reads the same first page forever, so the number here is the
 * measured maximum rather than a hopeful one.
 */
const PAGE_SIZE = 200;

/** Guards against a paginator that never advances. Four pod hosts, 200 each. */
const MAX_PAGES = 60;

/**
 * The public path shape, which is what a person clicks.
 *
 * The site in the URL is not always the site in the API — a board served as
 * `CX` redirects to `CX_2` — but the redirect resolves to the posting, and
 * following it ourselves would store a URL that breaks when the vendor
 * renumbers.
 */
export function oracleJobUrl(host: string, site: string, id: string): string {
  return `https://${host}/hcmUI/CandidateExperience/en/sites/${encodeURIComponent(site)}/job/${encodeURIComponent(id)}`;
}

/** The search endpoint for one page of one site. */
export function oracleSearchUrl(
  host: string,
  site: string,
  limit: number,
  offset: number,
): string {
  const finder = `findReqs;siteNumber=${site},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`;
  return (
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList.secondaryLocations,organizationsFacet` +
    `&finder=${encodeURIComponent(finder)}`
  );
}

/**
 * Oracle's workplace codes, which are more reliable than reading the location.
 *
 * ORA_REMOTE is genuinely remote; ORA_HYBRID is hybrid; ORA_ONSITE is on site.
 * Anything else falls through to the shared inference so a vendor adding a code
 * degrades to the old behaviour rather than mislabelling.
 */
function workplaceOf(code: string | undefined): string | undefined {
  switch ((code ?? '').toUpperCase()) {
    case 'ORA_REMOTE':
      return 'remote';
    case 'ORA_HYBRID':
      return 'hybrid';
    case 'ORA_ONSITE':
      return 'on-site';
    default:
      return undefined;
  }
}

export const oracleAdapter: AtsAdapter = {
  provider: 'oracle',
  endpointPattern:
    'https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs;siteNumber={site}',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const host = board.extra?.host;
    const site = board.extra?.site;
    if (!host || !site) {
      // Storing a half-formed board would fail every crawl forever, so say
      // which half is missing rather than letting it 404 in a week's time.
      throw new AtsFetchError(
        `oracle/${board.token}: needs extra.host and extra.site, got host=${host ?? 'none'} site=${site ?? 'none'}`,
        'oracle',
        board.token,
        undefined,
        'gone',
      );
    }

    const out: NormalizedJob[] = [];
    let offset = 0;
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && offset < total; page++) {
      const body = await getJson<OracleResponse>(
        oracleSearchUrl(host, site, PAGE_SIZE, offset),
        'oracle',
        board.token,
        ctx,
      );

      const search = body?.items?.[0];
      if (!search) {
        if (page === 0) {
          throw new AtsFetchError(
            `oracle/${board.token}: unexpected response shape`,
            'oracle',
            board.token,
          );
        }
        break;
      }

      const list = Array.isArray(search.requisitionList) ? search.requisitionList : [];
      // TotalJobsCount is reported on every page, but trusting a later page's
      // copy would let a changing total spin the loop. Take the first.
      if (total === Infinity) total = search.TotalJobsCount ?? list.length;
      if (list.length === 0) break;

      for (const r of list) {
        const title = r.Title?.trim();
        const id = r.Id != null ? String(r.Id) : undefined;
        if (!title || !id) continue;

        const secondary = (r.secondaryLocations ?? [])
          .map((l) => l.Name?.trim())
          .filter((n): n is string => Boolean(n));
        const locationRaw = r.PrimaryLocation?.trim();
        const url = oracleJobUrl(host, site, id);

        out.push({
          externalId: id,
          title,
          locationRaw,
          country: r.PrimaryLocationCountry ?? undefined,
          remoteType: resolveRemoteType(
            workplaceOf(r.WorkplaceTypeCode) ?? r.WorkplaceType,
            locationRaw,
            title,
            secondary.join(', '),
          ),
          department: r.Department ?? r.JobFamily ?? undefined,
          seniority: inferSeniority(title),
          // PostedDate is a bare "2026-09-15". The detail fetch carries a full
          // timestamp and describe.ts overwrites this with it where it can.
          postedAt: parseDate(r.PostedDate),
          applyUrl: url,
          listingUrl: url,
          raw: r,
        });
      }

      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
      offset += list.length;
    }

    return out;
  },
};

/**
 * The employer's own name. Two sources, because neither is enough alone.
 *
 * Exported because discovery needs this and the adapter does not: a board row
 * carries one company name and an opaque tenant code cannot supply it.
 *
 * THE FIRST ATTEMPT AT THIS WAS WRONG, AND IT SHIPPED
 *
 * The original rule trusted `organizationsFacet` only when it named exactly one
 * organisation, reasoning that a site spanning several has no single employer.
 * That is true of the facet and false of the board. Measured after the first
 * real discovery run stored 764 Oracle boards: the large tenants are precisely
 * the ones listing their subsidiaries, so the rule refused to name any of them
 * and the registry recorded Tata Capital as "Eofh", Lifepoint Health as
 * "Ibnjjb", WSP as "Emit" and Kotak Mahindra Bank as "Hcbt".
 *
 * The facet is ordered by posting count, so its first entry is the parent in
 * every case checked — "Tata Capital Limited", "Lifepoint Health",
 * "WSP USA Inc.", "Kotak Mahindra Bank Ltd". Taking the first is right; the old
 * comment's fear was of a list that does not occur.
 *
 * Better still is the career site's own page title, which carries the name the
 * employer chose to be called: "Tata Capital", not "Tata Capital Limited". So
 * the page is preferred and the facet is the fallback for the sites whose title
 * is Oracle's untouched template.
 */
export function oracleCompanyFrom(body: unknown): string | undefined {
  const facet = (body as OracleResponse | null)?.items?.[0]?.organizationsFacet;
  if (!Array.isArray(facet) || facet.length === 0) return undefined;
  const name = facet[0]?.Name?.trim();
  return name || undefined;
}

/**
 * Boilerplate Oracle's template wraps around the name, stripped from the title.
 *
 *   "Pearson Candidate Experience Site" -> Pearson
 *   "IHG Career"                        -> IHG
 *   "Candidate Experience site"         -> nothing, so the facet answers instead
 *   "Tata Capital"                      -> untouched
 *
 * Deliberately a short list of multi-word template phrases plus "career(s)".
 * Stripping every job-shaped word would eat real names — there is an employer
 * called Talent and one called Jobs — and the cost of being wrong here is a
 * company mislabelled in the feed.
 */
const SITE_BOILERPLATE =
  /[\s|·—–-]*(candidate\s+experience(\s+site)?|careers?\s+(site|portal|home|page)|external\s+careers?|careers?|recruiting)\s*$/i;

/** Shortest name treated as real, so a title trimmed to "A" is refused. */
const MIN_COMPANY_CHARS = 2;

/**
 * Titles that are not a name, however confidently the page serves them.
 *
 * Oracle career sites answer HTTP 200 with an error page. Two boards in the
 * first repair run were about to be renamed to "Page not found" — a phrase that
 * would have gone straight into the feed as an employer, and would have
 * replaced the names those two rows already had.
 *
 * A 200 is not proof of a page, in exactly the way a 200 is not proof of a
 * board elsewhere in this codebase.
 */
const NOT_A_NAME =
  /^(page not found|not found|error|404|403|access denied|forbidden|unauthori[sz]ed|loading|untitled|home|welcome|sign in|login|redirecting|service unavailable|maintenance)\.?$/i;

/**
 * A lead-in some employers put before their own name: "Careers at WorkplaceNL".
 * Stripped from the front, where SITE_BOILERPLATE only strips from the end.
 */
const NAME_PREFIX = /^\s*(careers?|jobs?|work|working)\s+(at|with|for)\s+/i;

export function oracleCompanyFromPage(html: string): string | undefined {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (!m?.[1]) return undefined;

  let name = m[1]
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();

  name = name.replace(NAME_PREFIX, '').trim();

  // Twice over: "Pearson Candidate Experience Site" needs one pass, and a title
  // like "Acme Careers Site Careers" needs two. Bounded so a pathological title
  // cannot loop.
  for (let i = 0; i < 3; i++) {
    const next = name.replace(SITE_BOILERPLATE, '').trim();
    if (next === name) break;
    name = next;
  }

  if (name.length < MIN_COMPANY_CHARS) return undefined;
  if (NOT_A_NAME.test(name)) return undefined;
  return name;
}

/** The career site's front page, which is where the title lives. */
export function oracleSitePageUrl(host: string, site: string): string {
  return `https://${host}/hcmUI/CandidateExperience/en/sites/${encodeURIComponent(site)}/`;
}
