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

// The countries warmed alongside the family tabs. Kept in step with
// SNAPSHOT_COUNTRIES in src/corpus/db-query.ts — the same combinations the crawl
// pre-counts, warmed here so the edge holds a copy too.
//
// These were the views actually returning "job data is temporarily unavailable":
// a family plus the US ran the rows and the counts together, and under
// concurrency both were killed by the 3-second limit. The stored counts fix the
// origin; warming them means a visitor does not wait on the origin at all. A
// 503 carries a short max-age and is never cached, so without warming every
// visitor paid for the failure again.
const COUNTRIES = ['US'];

// The landing views, in the order a visitor is most likely to hit them: the main
// feed and its family tabs first, then the country-scoped views that were
// breaking, then the two secondary pages and their tabs.
const PATHS = [
  '/api/feed',
  ...FAMILIES.map((f) => `/api/feed?family=${f}&sort=newest`),
  ...COUNTRIES.flatMap((c) => [
    `/api/feed?country=${c}`,
    ...FAMILIES.map((f) => `/api/feed?family=${f}&country=${c}`),
  ]),
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
