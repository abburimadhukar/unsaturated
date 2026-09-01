import { NextResponse } from 'next/server';
import {
  getFeed,
  queryFeed,
  facetsFor,
  MAX_AGE_DAYS,
  type FeedQuery,
  type SortKey,
} from '../../../src/corpus/live.js';

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
const FAMILIES = ['cloud', 'software', 'data', 'hris'];

// 50, not 200: the first screen is what people actually read, and 200 rows was
// 161 KB before anyone scrolled. The client raises `offset` for more.
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * How long the CDN may serve a response without asking again.
 *
 * The crawler writes hourly, so a minute of staleness costs nothing and turns
 * repeat visits, filter changes and crawler traffic into edge hits.
 */
const CACHE_HEADER = 'public, s-maxage=60, stale-while-revalidate=300';

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

  const offset = num('offset', { min: 0, max: 100_000 }) ?? 0;
  const limit = num('limit', { min: 1, max: MAX_PAGE_SIZE }) ?? PAGE_SIZE;

  let feed;
  try {
    feed = await getFeed();
  } catch (err) {
    // Without this the route threw Next's default HTML error page, which the
    // client then failed to parse as JSON and hung on forever.
    console.error('feed load failed:', err);
    return NextResponse.json({ error: 'feed temporarily unavailable' }, { status: 503 });
  }

  const query: FeedQuery = {
    cloudOnly: p.get('cloudOnly') !== '0',
    hideGhosts: p.get('hideGhosts') === '1',
    sort: sortRaw && SORTS.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : 'newest',
  };

  for (const key of ['remote', 'seniority', 'family', 'provider', 'country', 'q', 'employmentType'] as const) {
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

  let rows;
  let facets;
  try {
    rows = queryFeed(feed, query);

    // Facets describe the CURRENT result set, minus the one dimension each
    // facet offers. Computing them on the cloud-scoped set instead meant every
    // number beside every filter was the count you would get after clearing all
    // the other filters — "United States (1629)" next to 603 actual rows.
    const facetBase = (drop: keyof FeedQuery) => {
      const q: FeedQuery = { ...query };
      delete q[drop];
      return queryFeed(feed, q);
    };
    facets = {
      ...facetsFor(facetBase('family')),
      country: facetsFor(facetBase('country')).country,
      remote: facetsFor(facetBase('remote')).remote,
      provider: facetsFor(facetBase('provider')).provider,
    };
  } catch (err) {
    console.error('feed query failed:', err);
    return NextResponse.json({ error: 'query failed' }, { status: 500 });
  }

  // How many of the returned rows only survived because unknowns are kept.
  // Surfacing this stops a filter from quietly changing what "matched" means.
  const unknownIncluded = {
    country: query.country ? rows.filter((r) => !r.country).length : 0,
    seniority: query.seniority ? rows.filter((r) => !r.seniority).length : 0,
    remote: query.remote ? rows.filter((r) => !r.remoteType).length : 0,
    employmentType: query.employmentType ? rows.filter((r) => !r.employmentType).length : 0,
  };

  const page = rows.slice(offset, offset + limit);

  const res = NextResponse.json({
    total: feed.scanned ?? feed.jobs.length,
    inScope: feed.jobs.filter((j) => j.inScope).length,
    matched: rows.length,
    unknownIncluded,
    offset,
    limit,
    shown: page.length,
    hasMore: offset + page.length < rows.length,
    maxAgeDays: MAX_AGE_DAYS,
    refreshedAt: feed.refreshedAt,
    source: feed.source ?? 'live',
    boards: feed.boards,
    facets,
    jobs: page,
  });
  res.headers.set('cache-control', CACHE_HEADER);
  return res;
}
