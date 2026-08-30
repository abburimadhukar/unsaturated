import { NextResponse } from 'next/server';
import {
  getFeed,
  queryFeed,
  facetsFor,
  MAX_AGE_DAYS,
  type FeedQuery,
  type SortKey,
} from '../../../src/corpus/live.js';
import { getProfile, getState } from '../../../src/state/store.js';

export const dynamic = 'force-dynamic';

const SORTS: SortKey[] = ['newest', 'salary', 'fit'];

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const feed = await getFeed();
  const profile = await getProfile();
  const state = await getState();

  const num = (key: string) => {
    const raw = p.get(key);
    if (raw === null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (key: string) => p.get(key) || undefined;

  const sortRaw = p.get('sort') as SortKey | null;
  const query: FeedQuery = {
    cloudOnly: p.get('cloudOnly') !== '0',
    hideGhosts: p.get('hideGhosts') === '1',
    hideSeen: p.get('hideSeen') === '1',
    seenKeys: new Set(state.seen),
    skills: profile.skills,
    sort: sortRaw && SORTS.includes(sortRaw) ? sortRaw : 'newest',
  };

  for (const key of ['remote', 'seniority', 'family', 'provider', 'country', 'q', 'employmentType'] as const) {
    const v = str(key);
    if (v) query[key] = v;
  }
  const minSat = num('minSaturation');
  const minFit = num('minFit');
  const within = num('postedWithinDays');
  const minSalary = num('minSalary');
  if (minSat !== undefined) query.minSaturation = minSat;
  if (minFit !== undefined) query.minFit = minFit;
  if (within !== undefined) query.postedWithinDays = within;
  if (minSalary !== undefined) query.minSalary = minSalary;
  if (p.get('hasSalary') === '1') query.hasSalary = true;
  if (p.get('ai') === '1') query.ai = true;
  if (p.get('includeUnknown') === '0') query.includeUnknown = false;

  const rows = queryFeed(feed, query);

  // How many of the returned rows only survived because unknowns are kept.
  // Surfacing this stops a filter from quietly changing what "matched" means.
  const unknownIncluded = {
    country: query.country ? rows.filter((r) => !r.country).length : 0,
    seniority: query.seniority ? rows.filter((r) => !r.seniority).length : 0,
    remote: query.remote ? rows.filter((r) => !r.remoteType).length : 0,
  };

  // Facets are computed on the cloud-scoped set rather than the fully filtered
  // one, so the counts show what each option WOULD yield instead of collapsing
  // to zero as soon as a filter is applied.
  const base = queryFeed(feed, {
    cloudOnly: query.cloudOnly,
    hideGhosts: query.hideGhosts,
    skills: profile.skills,
  });

  return NextResponse.json({
    total: feed.scanned ?? feed.jobs.length,
    inScope: feed.jobs.filter((j) => j.inScope).length,
    matched: rows.length,
    unknownIncluded,
    shown: Math.min(rows.length, 200),
    maxAgeDays: MAX_AGE_DAYS,
    refreshedAt: feed.refreshedAt,
    source: feed.source ?? 'live',
    boards: feed.boards,
    facets: facetsFor(base),
    profile,
    state,
    jobs: rows.slice(0, 200),
  });
}
