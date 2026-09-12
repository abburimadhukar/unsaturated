/**
 * Which ATS vendors a job description can be read from.
 *
 * ITS OWN MODULE, WITH NO IMPORTS, FOR ONE REASON
 *
 * Both the server and the browser need this answer. The server needs it to decide
 * how to fetch; the feed needs it to decide whether to offer the button at all.
 *
 * It cannot live in jd.ts, which imports the ATS adapters and the crawler config —
 * pulling that into a client bundle would ship the whole crawler to the browser.
 * And it must not be duplicated, because a list copied into the UI is a list that
 * drifts: a vendor added on one side and not the other gives either a button that
 * always fails or a working feature nobody is offered.
 *
 * So: no imports, two arrays, one predicate.
 */

import type { AtsProvider } from '../ats/types.js';

/**
 * Vendors with a per-posting detail endpoint.
 *
 * These are the four fetchDetail implements. A fifth vendor having a detail page
 * in principle is not enough — this list means "we have written the fetcher".
 */
export const FROM_DETAIL: readonly AtsProvider[] = [
  'workday',
  'smartrecruiters',
  'workable',
  'bamboohr',
];

/**
 * Vendors whose board listing already carries the description.
 *
 * No detail endpoint is needed or used; the board is fetched through its own
 * adapter and the posting picked out by id.
 */
export const FROM_LISTING: readonly AtsProvider[] = [
  'greenhouse',
  'lever',
  'ashby',
  'socrata',
  'usajobs',
];

/**
 * Whether a description can be obtained for this provider at all.
 *
 * False for personio, breezy, rippling, teamtailor, recruitee and ukg. Measured
 * on the live corpus on 12 September 2026: 5,727 open in-scope postings behind
 * those six, 1,138 of them cloud or data roles. The feed uses this to leave the
 * button off rather than offer one that can only ever explain itself.
 */
export function canDescribe(provider: string): boolean {
  return (
    FROM_DETAIL.includes(provider as AtsProvider) || FROM_LISTING.includes(provider as AtsProvider)
  );
}
