import { NextResponse } from 'next/server';
import { queryFeedFromDb, facetsFromDb, type Facets } from '../../../src/corpus/db-query.js';
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
 */
const CACHE_HEADER = 'public, s-maxage=60, stale-while-revalidate=300';

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
  const fromDb = await queryFeedFromDb(query, offset, limit);
  if (fromDb) {
    const facets = (await facetsFromDb(query)) ?? {
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
      hasMore: offset + fromDb.jobs.length < fromDb.total,
      maxAgeDays: MAX_AGE_DAYS,
      // The last crawl, not this request. Stamping now() made the header read
      // "updated just now" however old the corpus actually was.
      refreshedAt: facets.refreshedAt ?? new Date().toISOString(),
      source: 'live',
      boards: [],
      facets,
      jobs: fromDb.jobs,
    });
    res.headers.set('cache-control', CACHE_HEADER);
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
