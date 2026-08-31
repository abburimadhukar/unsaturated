import { inferSeniority, resolveRemoteType } from '../normalize.js';
import { AtsFetchError, type AtsAdapter, type NormalizedJob } from '../types.js';
import { config } from '../../config.js';

interface WorkdayPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface WorkdayResponse {
  total?: number;
  jobPostings?: WorkdayPosting[];
}

const PAGE_SIZE = 20;

/**
 * Workday — POST {host}/wday/cxs/{tenant}/{site}/jobs
 *
 * The reason this adapter matters: Workday was 54% of the apply URLs in a real
 * sample, and it is where enterprise on-site roles live — banks, hospitals,
 * insurers, defense. It is also the provider both humans and competing bots
 * avoid, because applying means creating a per-tenant account and re-keying a
 * whole resume. That avoidance is exactly why its listings stay uncontested.
 *
 * Unlike the other adapters this needs a POST with a JSON body, and a board is
 * identified by three parts rather than one:
 *   token → tenant     (e.g. "ryder")
 *   extra.host         (e.g. "ryder.wd5.myworkdayjobs.com")
 *   extra.site         (e.g. "RyderCareers")
 */
export const workdayAdapter: AtsAdapter = {
  provider: 'workday',
  endpointPattern: 'https://{host}/wday/cxs/{tenant}/{site}/jobs',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const tenant = board.token;
    const host = board.extra?.host ?? `${tenant}.wd1.myworkdayjobs.com`;
    const site = board.extra?.site;
    if (!site) {
      throw new AtsFetchError(
        `workday/${tenant}: missing site name (run workday discovery first)`,
        'workday',
        tenant,
      );
    }

    const url = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
    const locale = board.extra?.locale ?? 'en-US';
    const doFetch = ctx.fetchImpl ?? fetch;
    const out: NormalizedJob[] = [];

    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);

      let body: WorkdayResponse;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'user-agent': ctx.userAgent,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' }),
        });
        if (!res.ok) {
          throw new AtsFetchError(`workday/${tenant}: HTTP ${res.status}`, 'workday', tenant, res.status);
        }
        body = (await res.json()) as WorkdayResponse;
      } catch (err) {
        if (err instanceof AtsFetchError) throw err;
        throw new AtsFetchError(
          `workday/${tenant}: ${err instanceof Error ? err.message : String(err)}`,
          'workday',
          tenant,
        );
      } finally {
        clearTimeout(timer);
      }

      const postings = body.jobPostings ?? [];
      // Workday reports `total` on the FIRST page only and sends 0 on every page
      // after it. `??` does not treat 0 as absent, so re-reading it each page
      // collapsed the loop bound to zero and every board stopped at exactly two
      // pages: KeyBank returned 40 of 559 postings, Travelers 40 of 353. Workday
      // is the largest single source in the corpus, so this was losing ~93% of
      // it. The short-page break below is what actually ends the loop.
      if (total === Infinity) total = body.total ?? postings.length;
      if (postings.length === 0) break;

      for (const p of postings) {
        if (!p.title) continue;
        const externalPath = p.externalPath ?? '';
        // externalPath first: it is the canonical URL path and always unique.
        // bulletFields normally carries the requisition id, but it is a
        // tenant-configured display list — a tenant that puts the location or
        // the posting date in slot 0 gives every job on the board the same id,
        // or one that changes daily.
        const reqId = p.bulletFields?.[0];
        const externalId = externalPath || reqId || p.title;
        const listingUrl = externalPath
          ? `https://${host}/${locale}/${site}${externalPath}`
          : undefined;

        out.push({
          externalId: String(externalId),
          title: p.title,
          locationRaw: p.locationsText,
          remoteType: resolveRemoteType(undefined, p.locationsText, p.title),
          seniority: inferSeniority(p.title),
          applyUrl: listingUrl,
          listingUrl,
          postedAt: parsePostedOn(p.postedOn),
          raw: p,
        });
      }

      offset += postings.length;
      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
      if (postings.length < PAGE_SIZE) break;
    }

    return out;
  },
};

/**
 * Workday reports age as prose — "Posted 3 Days Ago", "Posted 30+ Days Ago" —
 * never as a date. Converting it back to a timestamp is what lets Workday jobs
 * take part in the freshness signal and the retention window at all.
 *
 * "30+ Days Ago" is deliberately mapped to exactly 30 days rather than something
 * older: it is a floor, not a measurement, and dating it further back would
 * silently drop every such job out of the 30-day window.
 */
function startOfDay(ms: number): Date {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function parsePostedOn(text: string | undefined, now = Date.now()): Date | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();

  // "Posted Today" is a DAY, not a moment. Stamping it as `now` would claim
  // minute-level freshness Workday never gave us, and an "posted in the last 2
  // hours" filter would then fill up with jobs that might be 20 hours old.
  // Anchoring to the start of the day under-claims instead, which is the safe
  // direction: we never assert freshness we cannot prove.
  if (/today|just posted/.test(t)) return startOfDay(now);
  if (/yesterday/.test(t)) return startOfDay(now - 86_400_000);

  const plus = /(\d+)\+\s*days?/.exec(t);
  if (plus?.[1]) return new Date(now - Number(plus[1]) * 86_400_000);

  const days = /(\d+)\s*days?\s*ago/.exec(t);
  if (days?.[1]) return new Date(now - Number(days[1]) * 86_400_000);

  // Weeks were missing entirely, so "Posted 3 Weeks Ago" — a shape Workday
  // emits constantly — returned undefined. Undated jobs are exempt from the
  // 21-day retention cutoff, so those postings never aged out at all.
  const weeks = /(\d+)\+?\s*weeks?\s*ago/.exec(t);
  if (weeks?.[1]) return startOfDay(now - Number(weeks[1]) * 7 * 86_400_000);

  const months = /(\d+)\+?\s*months?\s*ago/.exec(t);
  if (months?.[1]) return startOfDay(now - Number(months[1]) * 30 * 86_400_000);

  const hours = /(\d+)\+?\s*hours?\s*ago/.exec(t);
  if (hours?.[1]) return startOfDay(now);

  // Some tenants configure a real date rather than prose.
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) {
    const ms = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  const mdy = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t);
  if (mdy) {
    const ms = Date.parse(
      `${mdy[3]}-${String(mdy[1]).padStart(2, '0')}-${String(mdy[2]).padStart(2, '0')}T00:00:00Z`,
    );
    if (Number.isFinite(ms)) return new Date(ms);
  }

  return undefined;
}

/**
 * Workday tenants are sharded across numbered data centres, ordered here by how
 * often they turn up in practice.
 */
export const WORKDAY_SHARDS = ['wd5', 'wd1', 'wd3', 'wd103', 'wd101', 'wd12', 'wd2', 'wd10'];

/**
 * Career-site names, ordered by observed frequency. Workday lets each customer
 * name their site freely, but the overwhelming majority pick one of these
 * conventions ("External" and "{Tenant}Careers" cover most of them).
 */
function siteCandidates(tenant: string): string[] {
  const Cap = tenant.charAt(0).toUpperCase() + tenant.slice(1);
  return [
    'External',
    'Careers',
    `${Cap}Careers`,
    'External_Career_Site',
    `${tenant.toUpperCase()}External_Career_Site`,
    `${Cap}_Careers`,
    'ExternalCareerSite',
    `${Cap}External`,
    // HPE uses "Jobsathpe"; several large tenants follow this shape.
    `Jobsat${tenant}`,
    `${Cap}_External_Career_Site`,
    'CareerSite',
  ];
}

/** Confirms a (host, site) pair by asking it for a single job. */
async function siteHasJobs(tenant: string, host: string, site: string): Promise<number | null> {
  try {
    const res = await fetch(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
      method: 'POST',
      headers: {
        'user-agent': config.userAgent,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as WorkdayResponse;
    return typeof body.total === 'number' && body.total > 0 ? body.total : null;
  } catch {
    return null;
  }
}

/**
 * Finds a tenant's shard and career-site name.
 *
 * The obvious approach — read the redirect from the tenant root — does not work:
 * myworkdayjobs.com answers 406 for every hostname including ones that do not
 * exist, so it reveals nothing. The only reliable probe is asking the jobs
 * endpoint itself, so this walks a shard × site-name matrix and stops at the
 * first combination that returns postings.
 *
 * `maxAttempts` bounds the request cost per company; the ordering above means
 * common tenants are usually found in the first few tries.
 */
export async function discoverWorkdaySite(
  tenant: string,
  maxAttempts = 24,
): Promise<{ host: string; site: string; locale: string; total: number } | null> {
  const sites = siteCandidates(tenant);
  let attempts = 0;

  for (const shard of WORKDAY_SHARDS) {
    const host = `${tenant}.${shard}.myworkdayjobs.com`;
    for (const site of sites) {
      if (attempts++ >= maxAttempts) return null;
      const total = await siteHasJobs(tenant, host, site);
      if (total !== null) return { host, site, locale: 'en-US', total };
    }
  }
  return null;
}
