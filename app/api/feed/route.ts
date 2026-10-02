import { NextResponse } from 'next/server';
import {
  queryFeedFromDb,
  queryNewestFromDb,
  queryRowsFromDb,
  facetsFromDb,
  isUnfilteredQuery,
  isFamilyOnlyQuery,
  isDefaultShapeQuery,
  type Facets,
  type FeedPage,
} from '../../../src/corpus/db-query.js';
// From ./types.js, not ./live.js. live.ts reads the board list and the build
// snapshot off disk, so importing even a constant from it pulled `node:fs` into
// the bundle — wasteful on a Node host and fatal on Workers, which have no
// filesystem.
import { MAX_AGE_DAYS, type FeedQuery, type SortKey } from '../../../src/corpus/types.js';
import {
  ALL_SPECIALIZATIONS,
  FAMILY_OF_SPECIALIZATION,
  UNKNOWN_SPECIALIZATION,
  isSpecialization,
} from '../../../src/taxonomy/specializations.js';

/**
 * The public job feed. Deliberately identical for every visitor.
 *
 * This used to embed the caller's resume skills and seen/applied marks, which
 * made every response unique and therefore uncacheable — 161 KB fetched from a
 * serverless function on every page load, filter change and bot hit. Resume
 * matching now happens in the browser against /api/me, so this response can sit
 * on the CDN and most requests never reach the origin at all.
 */
export const dynamic = 'force-dynamic';

// 'fit' is deliberately absent: it depends on the caller's resume, which this
// endpoint no longer sees. The browser sorts by match itself.
const SORTS: SortKey[] = ['newest', 'salary'];
// 'unsorted' is a review queue rather than a kind of work: postings no rule
// claimed and no rule rejected. Accepted here so it can be asked for by name,
// and excluded from every view that does not name it.
const FAMILIES = ['cloud', 'software', 'data', 'hris', 'unsorted'];
// Which stack a role is built on. Deliberately not a family: a full-stack job is
// genuinely both Python and JavaScript, so this is a property you filter on
// rather than a category the job belongs to.
const STACKS = ['python', 'other', 'unknown'];
// How far from the centre a role may be. Absent means core roles only — the
// default everywhere, so adjacent roles are always an explicit choice.
const ADJACENT = ['include', 'only'];

// 50, not 200: the first screen is what people actually read, and 200 rows was
// 161 KB before anyone scrolled. The client raises `offset` for more.
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * How long the CDN may serve a response without asking again.
 *
 * The crawler writes hourly, so a minute of staleness costs nothing and turns
 * repeat visits, filter changes and crawler traffic into edge hits.
 *
 * Still 60 seconds FRESH — freshness is the product, so this is unchanged. What
 * changed on 30 Sep 2026 is the two directives after it, both honoured by
 * Cloudflare's zone cache on the free plan (not the Workers Cache API, which this
 * site does not use — see open-next.config.ts):
 *
 *  - stale-while-revalidate=86400: once the 60 s lapses, a visitor is handed the
 *    cached copy INSTANTLY while the slow query refreshes in the background. The
 *    old window was 300 s, so on a quiet site a view untouched for six minutes
 *    became a hard miss that waited on a cold ~9 s query. A day's window means a
 *    view fetched even once a day never makes anyone wait for the database.
 *  - stale-if-error=86400: when the database times out — the 3 s statement limit
 *    that returns 503 "job data is temporarily unavailable" — the last good copy
 *    is served instead of the error, for up to a day. A day-old listing beats a
 *    blank page. It fires only on a 5xx, so the degraded 200 below (empty facets)
 *    is untouched and still self-heals in five seconds.
 *
 * The one case this cannot help is the FIRST request for a filter combination
 * never cached: there is nothing stale to fall back to, so it still hits the
 * origin cold. Warming the common views after each crawl is the follow-on.
 */
const CACHE_HEADER = 'public, s-maxage=60, stale-while-revalidate=86400, stale-if-error=86400';

/**
 * The same response, but only briefly, when the sidebar counts are missing.
 *
 * `facetsFromDb` returns null for every failure, and the fallback below fills in
 * empty facets — so the page renders every filter count as zero and the total as
 * 0, with the jobs listed right beside them. Measured 11 Sep 2026: one call in
 * twenty-five was refused with `canceling statement due to statement timeout`,
 * on a query that runs ~1.1s against anon's 3-second limit.
 *
 * Cached for 60 seconds and served stale for 300 more, one unlucky fill becomes
 * SIX MINUTES of every visitor seeing zeros. Watched happening on 11 Sep: five
 * consecutive requests reading total=0, then eight more, then healthy.
 *
 * Five seconds, not no-store. The obvious fix is to refuse to cache a degraded
 * answer at all, and it is wrong: the count failed BECAUSE the database was
 * busy, so sending every visitor straight at it is a stampede aimed at the thing
 * already struggling. Five seconds bounds the wrongness to a blink while still
 * letting one request shield the rest.
 */
const DEGRADED_CACHE_HEADER = 'public, s-maxage=5';

/**
 * How many of the returned rows only survived because unknowns are kept.
 * Surfacing this stops a filter quietly changing what "matched" means.
 */
function unknownsIn(
  jobs: { country: string | null; seniority: string | null; remoteType: string | null; employmentType: string | null }[],
  q: { country?: string; seniority?: string; remote?: string; employmentType?: string; postedWithinDays?: number },
  undated = 0,
) {
  return {
    // Always zero: country is an exact filter with its own "location unclear"
    // option, so choosing a country never quietly folds in undecoded rows.
    country: 0,
    seniority: q.seniority ? jobs.filter((r) => !r.seniority).length : 0,
    remote: q.remote ? jobs.filter((r) => !r.remoteType).length : 0,
    employmentType: q.employmentType ? jobs.filter((r) => !r.employmentType).length : 0,
    // Counted by the database over every matched row, not by filtering this
    // page: undated rows sort last, so the page-based count the others use
    // would read zero on page one and only become true after scrolling.
    postedWithin: q.postedWithinDays ? undated : 0,
  };
}

/** Corpus size, summed from the provider facet rather than a second query. */
function scannedFromFacets(f: Facets): number {
  return Object.values(f.provider).reduce((a, b) => a + b, 0);
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;

  // Invalid input used to be dropped silently, so a malformed number returned a
  // full unfiltered result set that looked like a successful query. Collect the
  // complaints and answer with 400 instead.
  const bad: string[] = [];

  const num = (key: string, { min, max }: { min?: number; max?: number } = {}) => {
    const raw = p.get(key);
    if (raw === null || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      bad.push(`${key} must be a number`);
      return undefined;
    }
    if (min !== undefined && n < min) {
      bad.push(`${key} must be at least ${min}`);
      return undefined;
    }
    if (max !== undefined && n > max) {
      bad.push(`${key} must be at most ${max}`);
      return undefined;
    }
    return n;
  };
  const str = (key: string) => p.get(key) || undefined;

  const sortRaw = p.get('sort');
  if (sortRaw && !SORTS.includes(sortRaw as SortKey)) {
    bad.push(`sort must be one of ${SORTS.join(', ')}`);
  }
  const familyRaw = str('family');
  if (familyRaw && !FAMILIES.includes(familyRaw)) {
    bad.push(`family must be one of ${FAMILIES.join(', ')}`);
  }
  const stackRaw = str('stack');
  if (stackRaw && !STACKS.includes(stackRaw)) {
    bad.push(`stack must be one of ${STACKS.join(', ')}`);
  }
  const adjacentRaw = str('adjacent');
  if (adjacentRaw && !ADJACENT.includes(adjacentRaw)) {
    // 'exclude' is deliberately not accepted: it is the default, and offering a
    // second way to spell the default splits the CDN cache for no gain.
    bad.push(`adjacent must be one of ${ADJACENT.join(', ')}`);
  }

  // Specialization is checked twice: that the value exists at all, and that it
  // belongs to the family asked for alongside it. Without the second check
  // `?family=software&specialization=devops_sre` is a perfectly well-formed
  // query that can only ever return zero rows — a filter combination that looks
  // like "no jobs match" when it is really a mistake. Answering 400 says which.
  const specRaw = str('specialization');
  if (specRaw && specRaw !== UNKNOWN_SPECIALIZATION) {
    if (!isSpecialization(specRaw)) {
      bad.push(`specialization must be ${UNKNOWN_SPECIALIZATION} or one of ${ALL_SPECIALIZATIONS.join(', ')}`);
    } else if (familyRaw && FAMILY_OF_SPECIALIZATION[specRaw] !== familyRaw) {
      bad.push(
        `specialization ${specRaw} belongs to family ${FAMILY_OF_SPECIALIZATION[specRaw]}, not ${familyRaw}`,
      );
    }
  }

  // Parameters that moved to the browser when the feed became public and
  // cacheable. Silently ignoring them would hand back an unfiltered result set
  // that looks like a successful query — the same quiet-failure the rest of this
  // route was fixed to avoid.
  // onlyApplied joined this list late and was missed: the browser correctly
  // stopped sending it, but the API happily accepted and ignored it, so a
  // shared URL carrying `onlyApplied=1` answered 200 with every job — a filter
  // that reads as applied and is not. Found by testing the deployed site, not
  // by anything local, because locally nothing sends it.
  for (const moved of ['minFit', 'hideSeen', 'onlyApplied'] as const) {
    if (p.get(moved) !== null) {
      bad.push(`${moved} is applied in the browser and is not accepted here`);
    }
  }

  const offset = num('offset', { min: 0, max: 100_000 }) ?? 0;
  const limit = num('limit', { min: 1, max: MAX_PAGE_SIZE }) ?? PAGE_SIZE;
  const query: FeedQuery = {
    cloudOnly: p.get('cloudOnly') !== '0',
    hideGhosts: p.get('hideGhosts') === '1',
    sort: sortRaw && SORTS.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : 'newest',
  };

  for (const key of ['remote', 'seniority', 'family', 'provider', 'country', 'q', 'employmentType', 'stack', 'specialization', 'adjacent'] as const) {
    const v = str(key);
    if (v) query[key] = v;
  }
  const within = num('postedWithinDays', { min: 1, max: MAX_AGE_DAYS });
  const minSalary = num('minSalary', { min: 0, max: 10_000_000 });
  if (within !== undefined) query.postedWithinDays = within;
  if (minSalary !== undefined) query.minSalary = minSalary;
  if (p.get('hasSalary') === '1') query.hasSalary = true;
  if (p.get('ai') === '1') query.ai = true;
  if (p.get('includeUnknown') === '0') query.includeUnknown = false;

  if (bad.length > 0) {
    return NextResponse.json({ error: 'invalid query', details: bad }, { status: 400 });
  }


  // Ask the database to filter, sort and page.
  //
  // The in-memory path below loads every open job — 16,754 rows, ~13.7 MB of
  // JSON — to render 50 of them, which at Supabase's 5 GB monthly egress is
  // about 365 cache misses before the allowance is gone. This asks for the page
  // instead, roughly 37 KB, and keeps the old path as the fallback so a database
  // outage still serves the build snapshot.
  //
  // Both questions at once. They are independent — the counts never read the
  // page — and asked one after the other the visitor waited for their SUM:
  // measured 17 Sep 2026, ~0.55 s for the page then ~1 s for the counts, from a
  // client, on every cache miss. Now it is the slower of the two. If the page
  // fails the counts are simply not used.
  //
  // The default view — no filters, newest first — takes a faster road: the
  // rows from feed_newest, and the total from the sidebar counts rather than a
  // recount of ~40,000 rows (2.6 s of feed_page's 2.6 s, against a 3 s limit;
  // measured 25 Sep 2026). For this view `adjacent.core` IS feed_page's total —
  // checked equal at the same instant — and it comes from the per-crawl
  // snapshot, so the matched figure and the sidebar agree with each other.
  // Anything missing on that road falls back to feed_page, as before.
  //
  // A family tab — only the family narrowed, newest first — takes the SAME road
  // (1 Oct 2026): feed_newest filtered to that family for the rows, and its
  // counts from the per-family snapshot, whose `adjacent.core` is that family's
  // total. This is the view (`family=cloud`) that 503'd on the free tier, because
  // feed_page counted the family's whole match for its total; the rows-only query
  // does not. If the per-family counts have not been computed yet it falls back to
  // the live count and then to feed_page, exactly as before.
  const familyFast = isFamilyOnlyQuery(query);
  const fast = query.sort === 'newest' && (isUnfilteredQuery(query) || familyFast);

  // The views a browser ACTUALLY asks for take the same road, one step along.
  //
  // Every real request carries hideGhosts=1 and country=US, because both are
  // FILTER_DEFAULTS and the feed page sends its whole filter state — so the
  // landing view and the four tabs match isDefaultShapeQuery, never the two
  // above. feed_newest cannot serve them: it knows only about family. feed_rows
  // can, because it takes the full filter set and simply does not count.
  //
  // This matters for more than speed. Taking the rows from feed_page means the
  // headline total is counted LIVE while the sidebar counts come from the
  // per-crawl snapshot, and the two can disagree whenever the snapshot is
  // behind. Reading both from the same stored answer keeps the number above the
  // list and the numbers beside it consistent with each other.
  const shapeFast = isDefaultShapeQuery(query);

  const [newest, shapeRows, slowPage, realFacets] = await Promise.all([
    fast ? queryNewestFromDb(offset, limit, {}, familyFast ? (query.family ?? null) : null) : Promise.resolve(null),
    // One row past the page, so hasMore stays exact without counting anything.
    shapeFast ? queryRowsFromDb(query, offset, limit + 1) : Promise.resolve(null),
    fast || shapeFast ? Promise.resolve(null) : queryFeedFromDb(query, offset, limit),
    facetsFromDb(query),
  ]);
  const fastTotal = realFacets?.adjacent?.core;
  // `total` is nullable here and nowhere else: the last-resort path below serves
  // the rows when NOTHING could count them, and an unknown total is reported as
  // unknown rather than as a number nobody measured.
  let fromDb: (Omit<FeedPage, 'total'> & { total: number | null; hasMore?: boolean }) | null = slowPage;
  if (fast) {
    fromDb = newest && typeof fastTotal === 'number'
      ? { jobs: newest.jobs, total: fastTotal, undated: 0, hasMore: newest.hasMore }
      : await queryFeedFromDb(query, offset, limit);
  } else if (shapeFast) {
    // Same rule as the fast road above: the rows are live, the total comes from
    // the counts, and anything missing falls back to feed_page rather than
    // showing a number nobody computed.
    fromDb = shapeRows && typeof fastTotal === 'number'
      ? {
          jobs: shapeRows.slice(0, limit),
          total: fastTotal,
          undated: 0,
          hasMore: shapeRows.length > limit,
        }
      : await queryFeedFromDb(query, offset, limit);
  }

  // A filtered view whose count timed out used to reach the visitor as a 503.
  //
  // feed_page returns the rows AND counts the whole match; on the free tier that
  // count is what exceeds the 3-second limit for a heavy combination like
  // family=cloud + country=US. When it fails but the facets came back, serve the
  // rows alone (feed_rows, no count) and take the total from the facets —
  // adjacent.core is the core total, exact while adjacent roles are excluded,
  // which is every view except the explicit `adjacent=include|only`. Those keep
  // feed_page's own count, so a wrong total is never shown. Sequential, not
  // parallel: this runs only after feed_page has actually failed, so the common
  // path fires no extra query at the database it is already straining.
  if (!fromDb && !query.adjacent && typeof fastTotal === 'number') {
    const rows = await queryRowsFromDb(query, offset, limit);
    if (rows) {
      fromDb = {
        jobs: rows,
        total: fastTotal,
        undated: 0,
        hasMore: offset + rows.length < fastTotal,
      };
    }
  }

  // LAST RESORT: the rows with no total at all.
  //
  // The fallback above can only run when the COUNTS survived, because it takes
  // the total from them. The failure this site actually has is both halves
  // dying together: feed_page and feed_facets are fired at the same instant and
  // compete for the same 3-second budget, so under load neither finishes. That
  // left `fromDb` null and `fastTotal` undefined, the gate above never opened,
  // and the visitor got "job data is temporarily unavailable" — while the one
  // query that would have answered, feed_rows, was never even asked. Measured
  // 2 Oct 2026: feed_page 388 ms against feed_facets ~1,000 ms, and every
  // feed_facets call touches the same 52,979 buffers whatever is filtered.
  //
  // So ask it. Rows are what a visitor came for; the sidebar numbers are not.
  // No gate on the facets and none on `adjacent`, because nothing here is taken
  // from either — the total is genuinely unknown and is sent as null rather
  // than as a number nobody counted, and the page renders the jobs with "—"
  // where the figure goes. One row more than the page is fetched so `hasMore`
  // stays exact without counting anything.
  if (!fromDb) {
    const rows = await queryRowsFromDb(query, offset, limit + 1);
    if (rows) {
      fromDb = {
        jobs: rows.slice(0, limit),
        total: null,
        undated: 0,
        hasMore: rows.length > limit,
      };
    }
  }
  if (fromDb) {
    // Remembered, because the cache header depends on it. Without this the
    // degraded answer was indistinguishable from a real one by the time the
    // header was set, and got the full 60+300 seconds.
    const facetsMissing = realFacets === null;
    // An unknown total is degraded too, and for the same reason: it means
    // something was refused, so the answer must not sit in the cache for a
    // minute plus a day of stale. Kept apart from `facetsMissing`, which is what
    // the x-facets header reports — a served page with counts and no total is a
    // real combination, and saying the facets were unavailable would be false.
    const degraded = facetsMissing || fromDb.total === null;
    const facets = realFacets ?? {
      family: {}, country: {}, remote: {}, provider: {}, seniority: {}, adjacent: {},
      stack: {}, specialization: {}, countryUnknown: 0, inScope: 0,
      refreshedAt: null, scanned: 0,
    };
    const res = NextResponse.json({
      total: facets.scanned || scannedFromFacets(facets),
      inScope: facets.inScope,
      matched: fromDb.total,
      unknownIncluded: unknownsIn(fromDb.jobs, query, fromDb.undated),
      offset,
      limit,
      shown: fromDb.jobs.length,
      hasMore: fromDb.hasMore ?? (fromDb.total !== null && offset + fromDb.jobs.length < fromDb.total),
      maxAgeDays: MAX_AGE_DAYS,
      // The last crawl, not this request. Stamping now() made the header read
      // "updated just now" however old the corpus actually was.
      refreshedAt: facets.refreshedAt ?? new Date().toISOString(),
      source: 'live',
      boards: [],
      facets,
      jobs: fromDb.jobs,
    });
    res.headers.set('cache-control', degraded ? DEGRADED_CACHE_HEADER : CACHE_HEADER);
    // So this is visible in a response rather than only in a Worker log.
    if (facetsMissing) res.headers.set('x-facets', 'unavailable');
    return res;
  }


  // No fallback here, deliberately.
  //
  // The in-memory path loaded every open job and filtered in JavaScript. On
  // Workers there is no filesystem for the build snapshot to live on, and
  // filtering 16,754 rows would blow through the 10 ms CPU budget a request
  // gets. If the database cannot answer, saying so is the honest response —
  // far better than hanging until the runtime kills the request.
  console.error('feed unavailable: the database did not answer');
  return NextResponse.json(
    { error: 'job data is temporarily unavailable' },
    { status: 503 },
  );
}
