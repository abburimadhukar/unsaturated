import { getText } from '../http.js';
import { decodeEntities, inferRemoteType, inferSeniority, stripHtml } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';

/**
 * iCIMS — careers-{token}.icims.com/jobs/search?ss=1&in_iframe=1
 *
 * THE FIRST ADAPTER THAT READS HTML, and the reason is that iCIMS publishes no
 * JSON at all. Measured 20 September 2026 against live boards: `format=json`
 * and `format=rss` both answer with the same HTML page, and there is no API
 * that answers without a customer's own credentials.
 *
 * What makes it worth doing anyway is that `?in_iframe=1` is not a scrape of a
 * rendered page — it is the server-rendered view iCIMS itself serves to the
 * career-site iframe, one <li> per posting, with the location, the title, the
 * requisition id and a description snippet already in the markup. No browser,
 * no JavaScript, no arms race.
 *
 * Measured the same day, 80 tokens sampled across the open dataset's 10,108:
 *
 *   live (HTTP 200 with a job table)   18   (23%)
 *   dead (404, host gone)              62
 *   postings behind the live ones   1,950   — 108 a board
 *
 * 108 a board is Oracle's density and sixteen times BambooHR's. The estate is
 * hospitals, county government, dealerships and care homes, so the family
 * filter will keep a smaller share of it than of a Greenhouse board — but the
 * boards themselves are exactly the uncontested half of the market this
 * project exists to surface.
 *
 * THE DEAD SHARE IS NOT A BUG. The dataset is historical, harvested from an
 * index, and a company that changed ATS leaves its old token behind. Nothing
 * here is trusted until cli/boards-verify.ts has seen it answer.
 */

/** One posting's markup, from <li class="iCIMS_JobCardItem"> to its close. */
function cards(html: string): string[] {
  const out: string[] = [];
  const parts = html.split(/<li[^>]*class="[^"]*iCIMS_JobCardItem[^"]*"[^>]*>/i);
  for (const part of parts.slice(1)) {
    const end = part.indexOf('</li>');
    out.push(end === -1 ? part : part.slice(0, end));
  }
  return out;
}

const text = (value: string | undefined): string | undefined => {
  const clean = decodeEntities(String(value ?? ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || undefined;
};

/**
 * The little labelled spans in a card's header row:
 *   <span class="sr-only field-label">Location</span><span> US-NY-Smithtown</span>
 *
 * Boards word them differently — "Location" on one, "Job Locations" on the
 * next — so the label is matched as a pattern rather than a fixed string.
 */
function headerField(card: string, label: string): string | undefined {
  const re = new RegExp(
    `field-label"[^>]*>\\s*(?:${label})\\s*</span>\\s*<span[^>]*>([\\s\\S]{0,160}?)</span>`,
    'i',
  );
  return text(re.exec(card)?.[1]);
}

function field(card: string, label: string): string | undefined {
  // <dt class="iCIMS_JobHeaderField">Category</dt><dd …><span> Operations</span>
  const re = new RegExp(
    `iCIMS_JobHeaderField"[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]{0,300}?)</dd>`,
    'i',
  );
  return text(re.exec(card)?.[1]);
}

/** The whole listing, page by page, as the paginator walks it. */
export function parseListing(html: string, token: string): NormalizedJob[] {
  const jobs: NormalizedJob[] = [];
  for (const card of cards(html)) {
    const link = /href="([^"]*\/jobs\/(\d+)\/[^"]*)"/i.exec(card);
    if (!link) continue;
    const title = text(/<h3[^>]*>([\s\S]{0,200}?)<\/h3>/i.exec(card)?.[1]);
    if (!title) continue;
    // A board with one office often omits the location altogether.
    const locationRaw = headerField(card, 'Job Locations?|Locations?');
    const description = text(
      /class="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]{0,4000}?)<\/div>/i.exec(card)?.[1],
    );
    // The requisition id the employer uses ("2026-5204"), wherever the board
    // puts it, falling back to the number in the URL — which is what the apply
    // page is addressed by, so there is always an id.
    const externalId = field(card, 'ID') ?? headerField(card, 'ID') ?? link[2]!;
    const listingUrl = decodeEntities(link[1]!).replace(/&amp;/g, '&');

    jobs.push({
      externalId: String(externalId),
      title,
      descriptionText: stripHtml(description),
      locationRaw,
      remoteType: inferRemoteType(locationRaw, `${title} ${description ?? ''}`),
      seniority: inferSeniority(title),
      department: field(card, 'Category'),
      employmentType: field(card, 'Job Type') ?? field(card, 'Type'),
      applyUrl: listingUrl,
      listingUrl,
      // iCIMS puts no publish date in the listing — not a truncated one, none
      // at all. Saying nothing is better than stamping the crawl's own date,
      // which is the very thing reading the vendor directly is meant to avoid.
      raw: { token },
    } satisfies NormalizedJob);
  }
  return jobs;
}

/** "Page 1 of 22" — the only statement of length the page makes. */
export function pageCount(html: string): number {
  const m = /Page\s+\d+\s+of\s+(\d+)/i.exec(html);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * The employer's real name, from the page's own title.
 *
 * iCIMS tokens are abbreviations — `chsli` is Catholic Health, `bowhead` is
 * UIC Alaska — so title-casing the token names almost nobody correctly. Every
 * board serves "Job Listings at {employer}", which is the employer's own
 * spelling of itself.
 */
export function icimsCompanyFrom(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  const title = /<title[^>]*>([^<]{2,200})<\/title>/i.exec(body)?.[1];
  if (!title) return undefined;
  // The phrase is not always at the start. Boards prefix it with their own
  // name or a menu crumb — "Fred Hutchinson Cancer Center Job Listings at Fred
  // Hutchinson Cancer Center", "Careers – Job Listings at North American
  // Construction Group" — so the name is whatever FOLLOWS the last occurrence.
  // Anchoring at the start named almost nobody, which is how 2,589 boards were
  // stored as "Fhcrc" and "Nacg" on 20 Sep 2026.
  const clean = decodeEntities(title).replace(/\s+/g, ' ').trim();
  const at = clean.toLowerCase().lastIndexOf('job listings at ');
  if (at === -1) return undefined;
  const name = clean.slice(at + 'job listings at '.length).trim();
  return name.length >= 2 && name.length <= 120 ? name : undefined;
}

/** Boards this large are read to a limit; the crawl keeps 300 a board anyway. */
const MAX_PAGES = 6;

/**
 * The board's own hostname.
 *
 * MOST iCIMS BOARDS ARE careers-{token}.icims.com AND NOT ALL OF THEM ARE.
 * Measured against the Common Crawl index on 22 September 2026, 995 distinct
 * iCIMS hosts: 620 in the careers- form and 374 in some other shape their
 * employer chose — abudhabi-nyu.icims.com is NYU Abu Dhabi, with ten jobs on
 * it, and academiccareers-udst.icims.com is the University of Doha with eleven.
 * Addressing those as careers-{token} reaches nothing.
 *
 * So the real host is stored when discovery saw one, and the careers- form is
 * the fallback for the 2,589 boards seeded from the open dataset, which carry a
 * token and no host. Both are live and both must keep working.
 */
export function icimsHost(board: { token: string; extra?: Record<string, string> }): string {
  const host = board.extra?.host;
  if (host && /^[a-z0-9][a-z0-9.-]*\.icims\.com$/i.test(host)) return host.toLowerCase();
  return `careers-${encodeURIComponent(board.token)}.icims.com`;
}

/** The listing URL for a board, used by the adapter and by verification alike. */
export function icimsListingUrl(board: { token: string; extra?: Record<string, string> }): string {
  return `https://${icimsHost(board)}/jobs/search?ss=1&in_iframe=1`;
}

export const icimsAdapter: AtsAdapter = {
  provider: 'icims',
  endpointPattern: 'https://{host}/jobs/search?ss=1&in_iframe=1',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const base = icimsListingUrl(board);
    const first = await getText(base, 'icims', board.token, ctx);
    // A token whose host has gone answers 404 and never reaches here; one that
    // answers with a page holding no job table is a live careers site with
    // nothing open, which is not an error.
    if (!/iCIMS_JobsTable|iCIMS_JobCardItem/i.test(first)) {
      if (/<html/i.test(first)) return [];
      throw new AtsFetchError(`icims/${board.token}: not an iCIMS listing`, 'icims', board.token);
    }

    const jobs = parseListing(first, board.token);
    const seen = new Set(jobs.map((j) => j.applyUrl));
    const pages = Math.min(pageCount(first), MAX_PAGES);
    for (let page = 1; page < pages; page++) {
      const html = await getText(`${base}&pr=${page}`, 'icims', board.token, ctx);
      const more = parseListing(html, board.token);
      // The paginator answers 200 for a page past the end and repeats the last
      // one, so a page that adds nothing new ends the walk.
      const fresh = more.filter((j) => !seen.has(j.applyUrl));
      if (!fresh.length) break;
      for (const j of fresh) seen.add(j.applyUrl);
      jobs.push(...fresh);
    }
    return jobs;
  },
};
