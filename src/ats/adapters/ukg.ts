import { postJson } from '../http.js';
import { inferRemoteType, inferSeniority, parseDate } from '../normalize.js';
import type { AtsAdapter, NormalizedJob } from '../types.js';

/**
 * UKG / UltiPro — recruiting.ultipro.com/{code}/JobBoard/{guid}/…
 *
 * Two identifiers, not one. A board is a company code AND a board id, and
 * neither works without the other — the same shape as Workday, which needs a
 * host and a site. The board id travels in `extra.board`, so a board record
 * missing it is unusable rather than half-working.
 *
 * The listing is a search endpoint and only answers POST, with paging in the
 * body. It reports `totalCount` alongside the page, which is what lets this
 * stop at the right moment instead of guessing.
 */

interface UkgAddress {
  City?: string | null;
  PostalCode?: string | null;
  State?: { Code?: string | null; Name?: string | null } | null;
  Country?: { Code?: string | null; Name?: string | null } | null;
}

interface UkgLocation {
  LocalizedDescription?: string | null;
  Address?: UkgAddress | null;
  IsRemote?: boolean | null;
}

interface UkgJob {
  Id?: string;
  Title?: string | null;
  RequisitionNumber?: string | null;
  FullTime?: boolean | null;
  JobCategoryName?: string | null;
  Locations?: UkgLocation[] | null;
  PostedDate?: string | null;
  BriefDescription?: string | null;
  IsRemote?: boolean | null;
}

interface UkgResponse {
  opportunities?: UkgJob[];
  totalCount?: number;
}

/** Pages are 50; enterprise boards run to several hundred postings. */
const PAGE = 50;

/**
 * A ceiling on paging, not on jobs.
 *
 * Without one, a board that reports a totalCount it never reaches — or answers
 * with the same page forever — would loop until the crawl's own timeout killed
 * it, taking every board behind it in the shard down with it.
 */
const MAX_PAGES = 20;

function locationOf(job: UkgJob): string | undefined {
  const first = job.Locations?.[0];
  if (!first) return undefined;
  const a = first.Address;
  const parts = [
    a?.City,
    a?.State?.Name ?? a?.State?.Code,
    a?.Country?.Name ?? a?.Country?.Code,
  ].filter((p): p is string => Boolean(p && p.trim()));
  // Falling back to the free-text description: some boards fill that in and
  // leave the structured address entirely null.
  if (parts.length === 0) return first.LocalizedDescription?.trim() || undefined;
  return [...new Set(parts.map((p) => p.trim()))].join(', ');
}

export const ukgAdapter: AtsAdapter = {
  provider: 'ukg',
  endpointPattern:
    'https://{extra.host}/{token}/JobBoard/{extra.board}/JobBoardView/LoadSearchResults',

  async fetchJobs(board, ctx): Promise<NormalizedJob[]> {
    const boardId = board.extra?.board;
    // Refusing beats guessing: with no board id there is no URL to call, and a
    // silent empty result would look like a company with no openings.
    if (!boardId) {
      throw new Error(`ukg board ${board.token} has no extra.board id`);
    }

    // UKG serves from two hosts and a board answers on only one of them, so the
    // host is part of the board's identity rather than a constant. Rows stored
    // before this default to the original.
    const host = board.extra?.host ?? 'recruiting.ultipro.com';
    const url =
      `https://${host}/${encodeURIComponent(board.token)}` +
      `/JobBoard/${encodeURIComponent(boardId)}/JobBoardView/LoadSearchResults`;

    const out: NormalizedJob[] = [];
    const seen = new Set<string>();
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await postJson<UkgResponse>(
        url,
        { opportunitySearch: { Top: PAGE, Skip: page * PAGE, QuerySort: [], SearchText: '' } },
        'ukg',
        board.token,
        ctx,
      );

      const batch = Array.isArray(body?.opportunities) ? body.opportunities : [];
      // Read once. Workday sends a total of 0 after the first page, and
      // reassigning each time made every board look 40 jobs deep — the same bug
      // is easy to write here.
      if (total === Infinity && typeof body?.totalCount === 'number') total = body.totalCount;
      if (batch.length === 0) break;

      for (const j of batch) {
        const title = (j.Title ?? '').trim();
        const id = j.Id ?? j.RequisitionNumber ?? undefined;
        if (!title || !id) continue;
        // Some boards return overlapping pages; a duplicate key would be
        // rejected by the upsert later anyway, and dropping it here is cheaper.
        if (seen.has(id)) continue;
        seen.add(id);

        const locationRaw = locationOf(j);
        const remote =
          j.IsRemote === true || j.Locations?.[0]?.IsRemote === true
            ? 'fully_remote'
            : inferRemoteType(locationRaw, title);
        const seniority = inferSeniority(title);
        const posted = parseDate(j.PostedDate ?? undefined);

        out.push({
          externalId: String(id),
          title,
          ...(locationRaw ? { locationRaw } : {}),
          ...(remote ? { remoteType: remote } : {}),
          ...(j.FullTime === true ? { employmentType: 'Full-Time' } : {}),
          ...(j.JobCategoryName ? { department: j.JobCategoryName } : {}),
          ...(seniority ? { seniority } : {}),
          ...(posted ? { postedAt: posted } : {}),
          applyUrl: `https://${host}/${board.token}/JobBoard/${boardId}/OpportunityDetail?opportunityId=${id}`,
          listingUrl: `https://${host}/${board.token}/JobBoard/${boardId}/OpportunityDetail?opportunityId=${id}`,
          raw: j,
        });
      }

      if (ctx.maxJobs !== undefined && out.length >= ctx.maxJobs) break;
      if (batch.length < PAGE || out.length >= total) break;
    }

    return out;
  },
};
