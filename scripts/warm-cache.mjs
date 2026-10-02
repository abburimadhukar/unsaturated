// Warm the edge cache for the views people actually land on.
//
// WHY THIS EXISTS. The three read routes serve a 60-second-fresh response that
// Cloudflare then serves stale-while-revalidating for a day and stale-on-error
// for a day (see app/api/feed/route.ts CACHE_HEADER). That removes the wait and
// the 503 for any view already in cache — but the FIRST request for a view that
// has fallen out of cache still hits the database cold, and on the free plan a
// cold count over the corpus is the ~9-second query that sometimes times out and
// returns "job data is temporarily unavailable". This fetches the common views
// once, right after each crawl, so a real visitor never draws the cold card.
//
// It is BEST-EFFORT. A warm that fails changes nothing a visitor sees that was
// not already true; the next crawl warms again an hour later. It fails the job
// only when EVERY view failed, which means the site itself is down and is worth a
// red square. A normal fetch is enough: a view in its stale window is handed back
// stale and a background refresh is triggered, which repopulates the cache fresh
// for the next caller; a cold view is fetched and cached outright.
//
// The base URL is the live site by default and overridable for a staging host.
// No credentials: every path warmed here is public, exactly as a visitor's
// browser would request it.

const BASE =
  process.env.WARM_BASE_URL ||
  process.argv[2] ||
  'https://unsaturated-jobs.rarejobs.workers.dev';

// Families and sectors are hardcoded rather than imported so this stays a plain
// .mjs with no build step. Kept in step with FAMILY_ORDER (minus 'unsorted',
// which is a review queue and never shown) in src/taxonomy/families.ts.
const FAMILIES = ['cloud', 'software', 'data', 'hris'];

/**
 * THE QUERY STRING THE FEED PAGE ACTUALLY SENDS.
 *
 * This file used to warm `/api/feed` and `/api/feed?family=cloud&country=US`.
 * A browser never asks for either, so for as long as this script has existed it
 * has been warming cache entries nobody reads — measured 2 Oct 2026, the real
 * landing request was a MISS every time while the warmed URL beside it was a
 * HIT.
 *
 * The cause is that the feed page serialises its WHOLE filter state, defaults
 * included (app/page.tsx `paramsFor`), while Quiet and Institutions use
 * `writeTo`, which omits anything still at its default. So those two were warmed
 * correctly and the feed never was.
 *
 * Four FILTER_DEFAULTS survive `paramsFor` on a view nobody has touched:
 *
 *   country: 'US'   cloudOnly: true   hideGhosts: true   sort: 'newest'
 *
 * and `load()` appends `limit=50`. ORDER MATTERS — Cloudflare keys on the exact
 * query string, and `paramsFor` emits in Object.entries order of
 * FILTER_DEFAULTS, which is why `family` comes before `country` and the booleans
 * come after both. tests/page-speed.test.ts rebuilds these strings from
 * FILTER_DEFAULTS itself and fails if the two ever drift again.
 */
const TAIL = 'cloudOnly=1&hideGhosts=1&sort=newest&limit=50';

/** One feed view, spelled exactly as the browser spells it. */
const feed = ({ family, country }) =>
  '/api/feed?' +
  [family && `family=${family}`, country && `country=${country}`, TAIL]
    .filter(Boolean)
    .join('&');

// The landing views, in the order a visitor is most likely to hit them.
//
// `country: 'US'` is a DEFAULT, not a choice — so the view every visitor lands
// on is the US one, and "All roles" clears the family while leaving the country
// alone. Both the US views and the country-cleared ones are warmed, because
// clearing the country is a single click from the landing page.
//
// Deliberately the same number of views as before (15). Every one of these is a
// cold origin query against a database that has just finished a crawl, so this
// list buys correctness, not volume; more combinations are worth adding only
// once these are confirmed landing as HITs.
const PATHS = [
  feed({ country: 'US' }),
  ...FAMILIES.map((f) => feed({ family: f, country: 'US' })),
  feed({}),
  ...FAMILIES.map((f) => feed({ family: f })),
  // Quiet and Institutions build their URLs with `writeTo`, which drops
  // defaults — so these two are already spelled the way the browser sends them.
  '/api/institutions',
  ...FAMILIES.map((f) => `/api/quiet?family=${f}`),
];

const ATTEMPTS = 3;
const BACKOFF_MS = 2000;
const TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch one path, retrying a cold timeout/5xx a couple of times with a wait. */
async function warm(path) {
  const url = `${BASE}${path}`;
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'unsaturated-cache-warmer/1.0' },
      });
      // Drain the body so the response is fully materialised and cached, not just
      // the headers.
      await res.arrayBuffer();
      const ms = Date.now() - started;
      const cf = res.headers.get('cf-cache-status') ?? '-';
      const facets = res.headers.get('x-facets') ? ' x-facets=unavailable' : '';
      if (res.ok) {
        console.log(`ok   ${res.status} ${String(ms).padStart(5)}ms cf=${cf}${facets}  ${path}`);
        return true;
      }
      last = `${res.status} cf=${cf}`;
      console.log(`warn ${res.status} ${String(ms).padStart(5)}ms cf=${cf}  ${path} (attempt ${attempt}/${ATTEMPTS})`);
    } catch (err) {
      last = err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(err?.message ?? err);
      console.log(`warn --- ${String(Date.now() - started).padStart(5)}ms  ${path} (attempt ${attempt}/${ATTEMPTS}: ${last})`);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < ATTEMPTS) await sleep(BACKOFF_MS * attempt);
  }
  console.log(`FAIL      ${path} — ${last}`);
  return false;
}

console.log(`Warming ${PATHS.length} views at ${BASE}`);
const results = [];
// One at a time, deliberately: warming is not a load test, and a cold miss that
// hits the database should not be fired alongside five others at the one thing
// already slow.
for (const path of PATHS) results.push(await warm(path));

const ok = results.filter(Boolean).length;
const failed = results.length - ok;
console.log(`\nWarmed ${ok}/${results.length} views${failed ? `, ${failed} failed` : ''}.`);

// Red only when nothing succeeded — that is the site being down, not a slow view.
if (ok === 0) {
  console.error('Every view failed to warm — the site appears to be down.');
  process.exit(1);
}
