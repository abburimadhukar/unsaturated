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
 * Vendors with a working per-posting detail endpoint.
 *
 * This list means "we have written the fetcher AND it returns a description from
 * the live vendor", not "the vendor has a detail page in principle".
 *
 * WORKABLE IS NOT HERE, AND THAT IS A MEASUREMENT
 *
 * describe.ts has a workableDetail that asks
 * apply.workable.com/api/v1/widget/accounts/{token}/jobs/{shortcode}. Probed
 * against the live vendor on 12 September 2026, that URL returns HTTP 404 — for
 * every shortcode tried, and with and without ?details=true. So does the v3
 * shape. There is no per-posting endpoint to call.
 *
 * Its descriptions are reachable, but only from the account listing with
 * ?details=true, which is a different route entirely — see WITH_DETAILS_PARAM.
 */
export const FROM_DETAIL: readonly AtsProvider[] = ['workday', 'smartrecruiters', 'bamboohr'];

/**
 * Vendors whose listing carries descriptions only when asked.
 *
 * Workable alone. Its plain account listing returns 19 fields per job and no
 * description — the adapter's own comment says so and it is correct. Adding
 * ?details=true adds one field, `description`, measured at 7,832 characters for a
 * posting whose detail endpoint 404s.
 *
 * The cost is the reason this is its own category rather than being folded into
 * FROM_LISTING: the parameter applies to the WHOLE account. One recruiting agency,
 * pavago, publishes 2,141 postings and its details listing is 15.5 MB. The median
 * Workable board in our corpus has 2 open jobs and the largest has 81, so this is
 * an outlier rather than the norm — but it is a real one, and it is why the read
 * is byte-capped rather than trusted to be small.
 */
export const WITH_DETAILS_PARAM: readonly AtsProvider[] = ['workable'];

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
  const p = provider as AtsProvider;
  return FROM_DETAIL.includes(p) || FROM_LISTING.includes(p) || WITH_DETAILS_PARAM.includes(p);
}
