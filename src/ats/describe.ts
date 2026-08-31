import { stripHtml } from './normalize.js';
import type { AtsProvider, BoardRef, FetchContext, NormalizedJob } from './types.js';

/**
 * Fetches full descriptions for providers whose board endpoint is listing-only.
 *
 * Workday and SmartRecruiters return titles and locations but no body text,
 * which left fit scoring unusable for most of the corpus — the UI simply showed
 * "—" because there was nothing to match a resume against.
 *
 * Descriptions cost one request per job, so callers must backfill selectively:
 * only jobs already judged in-scope, never the whole crawl.
 */

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
 * Providers this module can actually fetch a description for — the cases
 * fetchDescription implements.
 *
 * needsBackfill used to be the inverse of SELF_SUFFICIENT alone, so it returned
 * true for personio, breezy, rippling and socrata, none of which fetchDescription
 * handles. The caller then ran a whole classify-and-filter pass and reported
 * `described = 0` for boards that were never reachable, which reads as "these
 * jobs have no descriptions" rather than "we never asked".
 */
const BACKFILLABLE: AtsProvider[] = ['workday', 'smartrecruiters', 'workable'];

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

async function workdayDescription(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<string | null> {
  const raw = job.raw as { externalPath?: string } | undefined;
  const path = raw?.externalPath;
  const host = board.extra?.host;
  const site = board.extra?.site;
  if (!path || !host || !site) return null;

  const body = await getJson<WorkdayDetail>(
    `https://${host}/wday/cxs/${board.token}/${site}${path}`,
    ctx,
  );
  return stripHtml(body?.jobPostingInfo?.jobDescription) ?? null;
}

async function smartRecruitersDescription(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<string | null> {
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
  return stripHtml(text) ?? null;
}

async function workableDescription(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<string | null> {
  const body = await getJson<{ description?: string; requirements?: string }>(
    `https://apply.workable.com/api/v1/widget/accounts/${board.token}/jobs/${job.externalId}`,
    ctx,
  );
  if (!body) return null;
  return stripHtml([body.description, body.requirements].filter(Boolean).join('\n\n')) ?? null;
}

export async function fetchDescription(
  board: BoardRef,
  job: NormalizedJob,
  ctx: FetchContext,
): Promise<string | null> {
  switch (board.provider) {
    case 'workday':
      return workdayDescription(board, job, ctx);
    case 'smartrecruiters':
      return smartRecruitersDescription(board, job, ctx);
    case 'workable':
      return workableDescription(board, job, ctx);
    default:
      return null;
  }
}

/**
 * Backfills descriptions in place with bounded concurrency.
 *
 * `limit` caps how many jobs one board may backfill so a single enterprise board
 * with hundreds of matches cannot dominate a refresh.
 */
export async function backfillDescriptions(
  board: BoardRef,
  jobs: NormalizedJob[],
  ctx: FetchContext,
  limit = 80,
  concurrency = 4,
): Promise<number> {
  const targets = jobs.filter((j) => !j.descriptionText).slice(0, limit);
  if (targets.length === 0) return 0;

  let cursor = 0;
  let filled = 0;

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const job = targets[cursor++];
      if (!job) break;
      const text = await fetchDescription(board, job, ctx);
      if (text) {
        job.descriptionText = text;
        filled++;
      }
    }
  });

  await Promise.all(workers);
  return filled;
}
