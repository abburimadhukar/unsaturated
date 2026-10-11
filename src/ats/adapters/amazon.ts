import { getJson } from '../http.js';
import { inferSeniority, parseDate, resolveRemoteType, stripHtml } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

/**
 * Amazon — www.amazon.jobs/en/search.json
 *
 * Amazon is the largest Washington employer and ran nowhere in the corpus: it
 * publishes its own listings API rather than using a third-party ATS, so no
 * generic discovery could ever reach it. The endpoint is public, keyless and
 * fast (HTTP 200 in ~0.7s from a GitHub runner, probed 10 October 2026), and it
 * returns the full description inline — so Amazon is a SELF_SUFFICIENT provider
 * like Greenhouse, with no per-posting detail fetch.
 *
 * ADDRESSING A BOARD
 *
 * Amazon is one global board, not one per employer, so a single registry row
 * would either be capped at 300 postings (DEFAULT_MAX_JOBS) — a rounding error
 * against ~5,500 open Washington roles alone — or, uncapped, hold a crawl shard
 * for hundreds of requests. Instead a board is scoped to ONE US state, the unit
 * the Washington page is built on:
 *
 *   token         "us-wa" — a stable identity, not read by the API
 *   extra.stateName  the value the API filters on — "Washington"
 *   extra.state      the 2-letter code used to keep only primary-state roles — "WA"
 *   extra.country    ISO-3 country for the API — defaults to "USA"
 *
 * One row per state keeps each board's pagination bounded (300 most-recent roles
 * a crawl, newest-first) and makes every state a one-line seed with no code
 * change. Washington is the only state seeded today.
 *
 * WHY THE RESPONSE IS FILTERED BY STATE IN CODE
 *
 * `normalized_state_name=Washington` is a LOOSE filter: it returns every role
 * that merely lists a Washington location among several, so a role whose primary
 * site is San Francisco comes back with `state: "CA"`. Measured 10 Oct 2026: a
 * single WA page held CA, IL, MA, NY, TX and VA rows alongside WA. Each job
 * carries an exact `state` code, so the adapter keeps only the rows whose
 * primary state matches, and the board's 300-posting budget is then all
 * Washington. (region is still re-derived centrally from locationRaw, so a
 * mis-scoped row could never reach the wrong state page — this only decides what
 * the WA board spends its budget on.)
 *
 * WHAT THE API DOES THAT A PAGINATOR MUST NOT ASSUME AWAY
 *
 * `result_limit` caps at 100: asking for 500 returns an empty `jobs` array, not
 * 500, so a loop keyed on the requested size would read nothing. The loop pages
 * by 100 and advances by what came back. `hits` is capped at 10,000 for broad
 * queries; a single state is well under that, so the count is exact and the loop
 * stops at it.
 *
 * `sort=recent` is not decoration: with the crawl keeping at most 300 a board,
 * which 300 come back decides what the site shows, and freshness is the product.
 */

interface AmazonJob {
  id?: number | string;
  title?: string;
  /** Clean, display-ready: "Seattle, Washington, USA", "Washington, District of Columbia, USA". */
  normalized_location?: string;
  /** The raw form, "US, WA, Seattle" — a backstop when normalized_location is absent. */
  location?: string;
  city?: string;
  /** The 2-letter state code the response filter is checked against. */
  state?: string;
  posted_date?: string;
  job_path?: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
  business_category?: string;
  job_category?: string;
  is_intern?: boolean;
}

interface AmazonResponse {
  error?: unknown;
  hits?: number;
  jobs?: AmazonJob[];
}

/** The vendor's own page-size ceiling, measured — asking for more returns none. */
export const AMAZON_PAGE = 100;

/**
 * An upper bound on pages for one board. A state is well under the API's 10,000
 * `hits` cap, and the crawl stops at ctx.maxJobs (300) long before this; it only
 * guards an uncapped caller (the live probe) against reading a whole state.
 */
const MAX_PAGES = 100;

const AMAZON_BASE = 'https://www.amazon.jobs';

export function amazonListUrl(
  stateName: string,
  country: string,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams();
  params.append('normalized_country_code[]', country);
  params.append('normalized_state_name[]', stateName);
  params.set('sort', 'recent');
  params.set('offset', String(offset));
  params.set('result_limit', String(limit));
  return `${AMAZON_BASE}/en/search.json?${params.toString()}`;
}

/** The posting's own page on amazon.jobs. job_path already starts with "/". */
function applyUrlOf(job: AmazonJob): string | undefined {
  return job.job_path ? `${AMAZON_BASE}${job.job_path}` : undefined;
}

/** Description, basic and preferred qualifications, as one HTML block. */
function descriptionHtmlOf(job: AmazonJob): string | undefined {
  const parts = [
    job.description,
    job.basic_qualifications ? `<h3>Basic qualifications</h3>${job.basic_qualifications}` : undefined,
    job.preferred_qualifications
      ? `<h3>Preferred qualifications</h3>${job.preferred_qualifications}`
      : undefined,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export const amazonAdapter: AtsAdapter = {
  provider: 'amazon',
  endpointPattern: 'https://www.amazon.jobs/en/search.json?normalized_state_name={state}',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const stateName = board.extra?.stateName;
    if (!stateName) {
      throw new AtsFetchError(
        `amazon/${board.token}: needs extra.stateName — the board is scoped to one US state`,
        'amazon',
        board.token,
        undefined,
        'gone',
      );
    }
    const country = board.extra?.country ?? 'USA';
    // The 2-letter code the primary-state filter checks. Absent means "keep
    // every row the API returned", which is only safe for a caller that wants
    // the loose set; the seeded boards always set it.
    const stateCode = board.extra?.state?.toUpperCase();

    const out: NormalizedJob[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && offset < total; page++) {
      const body = await getJson<AmazonResponse>(
        amazonListUrl(stateName, country, offset, AMAZON_PAGE),
        'amazon',
        board.token,
        ctx,
      );
      if (!body || !Array.isArray(body.jobs)) {
        if (page === 0) {
          throw new AtsFetchError(`amazon/${board.token}: unexpected response shape`, 'amazon', board.token);
        }
        break;
      }
      if (total === Infinity) total = typeof body.hits === 'number' ? body.hits : body.jobs.length;
      if (body.jobs.length === 0) break;

      for (const job of body.jobs) {
        const id = job.id != null ? String(job.id) : undefined;
        const title = job.title?.trim();
        if (!id || !title || seen.has(id)) continue;
        // Keep only the rows whose primary state is the one this board is for —
        // the API's state filter is inclusive of secondary locations.
        if (stateCode && job.state?.toUpperCase() !== stateCode) continue;
        seen.add(id);

        const locationRaw = (job.normalized_location ?? job.location ?? '').trim() || undefined;
        const html = descriptionHtmlOf(job);
        const applyUrl = applyUrlOf(job);

        out.push({
          externalId: id,
          title,
          descriptionHtml: html,
          descriptionText: stripHtml(html),
          locationRaw,
          department: job.business_category || job.job_category || undefined,
          remoteType: resolveRemoteType(undefined, locationRaw, title),
          seniority: job.is_intern ? 'entry' : inferSeniority(title),
          applyUrl,
          listingUrl: applyUrl,
          // "October 10, 2026" — sometimes with a double space before a
          // single-digit day. Collapse whitespace before parsing.
          postedAt: parseDate(job.posted_date?.replace(/\s+/g, ' ')),
          raw: job,
        });

        if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) return out;
      }

      offset += body.jobs.length;
    }

    return out;
  },
};
