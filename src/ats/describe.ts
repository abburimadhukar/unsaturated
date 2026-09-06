import { parseDate, stripHtml } from './normalize.js';
import type { AtsProvider, BoardRef, FetchContext, NormalizedJob } from './types.js';

/**
 * Fetches the detail page for providers whose board endpoint is listing-only.
 *
 * Workday and SmartRecruiters return titles and locations but no body text,
 * which left fit scoring unusable for most of the corpus — the UI simply showed
 * "—" because there was nothing to match a resume against.
 *
 * BambooHR is worse than that: its listing carries no publish date either, so
 * all 1,478 stored postings fell back to "when we first saw it", which is today
 * for a board discovered today. A sample of 40 checked against BambooHR's own
 * detail page found 33 older than our 21-day window, 9 older than 90 days and
 * two over a year — the oldest from December 2024, being shown as posted today.
 * Ghost-risk could not catch them either, because it keys off the date we did
 * not have.
 *
 * So this returns a detail record rather than a string: whatever the listing
 * left out and the detail page happens to know.
 *
 * Detail pages cost one request per job, so callers must backfill selectively:
 * only jobs already judged in-scope or headed for the review queue, never the
 * whole crawl.
 */

/** What a detail page can add to a listing row. */
export interface JobDetail {
  description?: string;
  postedAt?: Date;
}

interface WorkdayDetail {
  jobPostingInfo?: { jobDescription?: string };
}

interface SmartRecruitersDetail {
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string } | undefined>;
  };
}

/** Providers whose list endpoint already includes the description. */
const SELF_SUFFICIENT: AtsProvider[] = ['greenhouse', 'lever', 'ashby', 'socrata', 'usajobs'];

/**
 * Providers this module can actually fetch a detail page for — the cases
 * fetchDetail implements.
 *
 * needsBackfill used to be the inverse of SELF_SUFFICIENT alone, so it returned
 * true for personio, breezy, rippling and socrata, none of which fetchDetail
 * handles. The caller then ran a whole classify-and-filter pass and reported
 * `described = 0` for boards that were never reachable, which reads as "these
 * jobs have no descriptions" rather than "we never asked".
 *
 * bamboohr is here for the date as much as the text: its listing has neither,
 * and its detail page has both.
 */
const BACKFILLABLE: AtsProvider[] = ['workday', 'smartrecruiters', 'workable', 'bamboohr'];

export function needsBackfill(provider: AtsProvider): boolean {
  return !SELF_SUFFICIENT.includes(provider) && BACKFILLABLE.includes(provider);
}

async function getJson<T>(url: string, ctx: FetchContext, init?: RequestInit): Promise<T | null> {
  try {
    const res = await (ctx.fetchImpl ?? fetch)(url, {
      ...init,
      headers: { 'user-agent': ctx.userAgent, accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function workdayDetail(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<JobDetail | null> {
  const raw = job.raw as { externalPath?: string } | undefined;
  const path = raw?.externalPath;
  const host = board.extra?.host;
  const site = board.extra?.site;
  if (!path || !host || !site) return null;

  const body = await getJson<WorkdayDetail>(
    `https://${host}/wday/cxs/${board.token}/${site}${path}`,
    ctx,
  );
  const description = stripHtml(body?.jobPostingInfo?.jobDescription);
  return description ? { description } : null;
}

async function smartRecruitersDetail(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<JobDetail | null> {
  const body = await getJson<SmartRecruitersDetail>(
    `https://api.smartrecruiters.com/v1/companies/${board.token}/postings/${job.externalId}`,
    ctx,
  );
  const sections = body?.jobAd?.sections;
  if (!sections) return null;

  // Qualifications matter as much as the description here: that is where the
  // required stack is usually listed, and the stack is what fit matches on.
  const text = ['jobDescription', 'qualifications', 'additionalInformation']
    .map((k) => sections[k]?.text)
    .filter(Boolean)
    .join('\n\n');
  const description = stripHtml(text);
  return description ? { description } : null;
}

async function workableDetail(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<JobDetail | null> {
  const body = await getJson<{ description?: string; requirements?: string }>(
    `https://apply.workable.com/api/v1/widget/accounts/${board.token}/jobs/${job.externalId}`,
    ctx,
  );
  if (!body) return null;
  const description = stripHtml(
    [body.description, body.requirements].filter(Boolean).join('\n\n'),
  );
  return description ? { description } : null;
}

/**
 * BambooHR — {token}.bamboohr.com/careers/{id}/detail
 *
 * The only provider here fetched for its DATE rather than its text. `datePosted`
 * is a bare "YYYY-MM-DD" and is the employer's own answer, which beats the
 * first_seen_at fallback by however long the posting sat there before we found
 * the board — in the sample, usually months.
 *
 * The description is taken too, since the request is already paid for.
 */
async function bambooHrDetail(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<JobDetail | null> {
  const body = await getJson<{
    result?: { jobOpening?: { description?: string; datePosted?: string } };
  }>(`https://${board.token}.bamboohr.com/careers/${job.externalId}/detail`, ctx);

  const opening = body?.result?.jobOpening;
  if (!opening) return null;

  const description = stripHtml(opening.description);
  const postedAt = parseDate(opening.datePosted ?? undefined);
  // A detail page that gave us neither is not worth reporting as a fill.
  if (!description && !postedAt) return null;
  return { ...(description ? { description } : {}), ...(postedAt ? { postedAt } : {}) };
}

export async function fetchDetail(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<JobDetail | null> {
  switch (board.provider) {
    case 'workday':
      return workdayDetail(board, job, ctx);
    case 'smartrecruiters':
      return smartRecruitersDetail(board, job, ctx);
    case 'workable':
      return workableDetail(board, job, ctx);
    case 'bamboohr':
      return bambooHrDetail(board, job, ctx);
    default:
      return null;
  }
}

/**
 * Fills in missing detail in place, with bounded concurrency.
 *
 * `limit` caps how many jobs one board may backfill so a single enterprise board
 * with hundreds of matches cannot dominate a refresh.
 *
 * A job qualifies when it is missing EITHER the description or the date. The
 * date half is what BambooHR needs — its listing has a title and nothing else
 * datable — and it costs the other providers nothing, because their listings
 * already carry a date and their rows only ever qualify on the description.
 *
 * Never overwrites: a value the listing supplied is the vendor's own answer for
 * the field, and a detail page is here to fill gaps rather than to second-guess.
 */
export async function backfillDescriptions(
  board: BoardRef,
  jobs: NormalizedJob[],
  ctx: FetchContext,
  limit = 80,
  concurrency = 4,
): Promise<number> {
  const targets = jobs.filter((j) => !j.descriptionText || !j.postedAt).slice(0, limit);
  if (targets.length === 0) return 0;

  let cursor = 0;
  let filled = 0;

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const job = targets[cursor++];
      if (!job) break;
      const detail = await fetchDetail(board, job, ctx);
      if (!detail) continue;
      let gained = false;
      if (detail.description && !job.descriptionText) {
        job.descriptionText = detail.description;
        gained = true;
      }
      if (detail.postedAt && !job.postedAt) {
        job.postedAt = detail.postedAt;
        gained = true;
      }
      if (gained) filled++;
    }
  });

  await Promise.all(workers);
  return filled;
}
