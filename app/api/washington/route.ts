import { NextResponse } from 'next/server';
import { db } from '../../../src/db/supabase.js';
import { MAX_AGE_DAYS } from '../../../src/corpus/types.js';
import { FAMILY_ORDER } from '../../../src/taxonomy/families.js';

/**
 * Washington State roles.
 *
 * Its own route for the same reason /api/quiet and /api/institutions are:
 * feed_page cannot gain a parameter without being dropped and recreated, which
 * has nearly taken this site down once. This needs one extra condition —
 * region = 'WA' — and nothing else, so it reads the jobs table directly and
 * leaves every existing code path untouched.
 *
 * `region` is a stored column written from the location at crawl time
 * (2026-10-06-region.sql), so the filter is an indexed equality rather than a
 * pattern matched against every row per request. Matching "%washington%" or
 * "%WA%" live would be both slow — the measured failure that `quiet` exists to
 * avoid — and wrong, catching Washington, D.C., Warsaw and Walla Walla County
 * in other states.
 *
 * ADJACENT ROLES ARE INCLUDED HERE, unlike on Quiet Roles and Institutions.
 * This is a geography, not a kind of work: someone hiring in Seattle wants the
 * Solutions Engineer and the Technical Program Manager alongside the core roles,
 * and the card labels an adjacent one so the inclusion is honest rather than
 * hidden. The review pile ('unsorted') stays out, as everywhere.
 */
export const dynamic = 'force-dynamic';

const STATE = 'WA';
const FAMILIES = FAMILY_ORDER.filter((f) => f !== 'unsorted');

/** The four values remote_type actually holds; anything else is rejected. */
const WORKPLACES = ['on_site', 'hybrid', 'fully_remote'];

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// 60 s fresh, then a day of serve-stale-while-revalidating and serve-stale-on-
// error — the same reasoning as the main feed and the other two pages: nobody
// waits on a cold query, and a database timeout serves the last good copy
// rather than a 503.
const CACHE_HEADER = 'public, s-maxage=60, stale-while-revalidate=86400, stale-if-error=86400';
/** Same reasoning as the main feed's: seconds, not no-store, so a busy database is not stampeded. */
const DEGRADED_CACHE_HEADER = 'public, s-maxage=5';

interface Row {
  key: string;
  title: string;
  company: string;
  provider: string;
  location: string | null;
  country: string | null;
  region: string | null;
  remote_type: string | null;
  seniority: string | null;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  posted_at: string | null;
  first_seen_at: string | null;
  apply_url: string | null;
  family: string | null;
  specialization: string | null;
  adjacent: boolean | null;
}

/**
 * The same window the main feed uses, expressed the same way. Undated rows are
 * bounded by when we first saw them rather than waved through — waving them
 * through is what once made "past 24 hours" show four-day-old postings.
 */
function windowFilter(cutoff: string): string {
  return `posted_at.gte.${cutoff},and(posted_at.is.null,first_seen_at.gte.${cutoff})`;
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const bad: string[] = [];

  const family = p.get('family') ?? FAMILIES[0]!;
  if (!FAMILIES.includes(family as (typeof FAMILIES)[number])) {
    bad.push(`family must be one of ${FAMILIES.join(', ')}`);
  }

  const num = (key: string, min: number, max: number, fallback: number) => {
    const raw = p.get(key);
    if (raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      bad.push(`${key} must be a number between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const limit = num('limit', 1, MAX_PAGE_SIZE, PAGE_SIZE);
  const offset = num('offset', 0, 100_000, 0);

  const workplace = (p.get('workplace') ?? '').trim();
  if (workplace && !WORKPLACES.includes(workplace)) {
    bad.push(`workplace must be one of ${WORKPLACES.join(', ')}`);
  }

  const seniority = (p.get('seniority') ?? '').trim();
  const SENIORITIES = ['entry', 'mid', 'senior', 'staff', 'principal', 'lead'];
  if (seniority && !SENIORITIES.includes(seniority)) {
    bad.push(`seniority must be one of ${SENIORITIES.join(', ')}`);
  }

  const paidOnly = p.get('paidOnly') === '1';

  /**
   * How recently a role was posted, in days. Same control the main feed offers
   * (24 hours / 3 / 7 / 14), capped at MAX_AGE_DAYS because nothing older is
   * kept. It tightens the window below rather than adding a separate condition,
   * so undated rows stay bounded by first_seen_at exactly as they already are —
   * the card labels those "seen Nd" rather than inventing a posting date.
   */
  let withinDays = MAX_AGE_DAYS;
  const postedWithinRaw = (p.get('postedWithin') ?? '').trim();
  if (postedWithinRaw) {
    const n = Number(postedWithinRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_AGE_DAYS) {
      bad.push(`postedWithin must be a whole number of days between 1 and ${MAX_AGE_DAYS}`);
    } else {
      withinDays = n;
    }
  }

  /** Title and employer. The commas and parens that would break PostgREST's
   *  filter grammar are stripped rather than sent. */
  const search = (p.get('q') ?? '').trim().slice(0, 80).replace(/[(),*]/g, ' ').trim();

  if (bad.length > 0) {
    return NextResponse.json({ error: 'invalid query', details: bad }, { status: 400 });
  }

  const cutoff = new Date(Date.now() - withinDays * 86_400_000).toISOString();
  const client = db();

  /**
   * The narrowings every query here shares — the state, the window, and the
   * optional filters — but NOT the family. The list adds the family; the tab
   * counts apply it one family at a time. Keeping them in one place is what
   * stops the counts and the list quietly disagreeing.
   *
   * Typed through a minimal self-returning chain rather than PostgREST's own
   * builder generics, so the caller's concrete query type survives the call and
   * `.eq('family', …).order(…).range(…)` still checks afterwards.
   */
  interface Chain {
    is(column: string, value: null): Chain;
    eq(column: string, value: string): Chain;
    neq(column: string, value: string): Chain;
    not(column: string, op: string, value: null): Chain;
    or(filter: string): Chain;
  }
  const narrow = <T>(q: T): T => {
    let out = (q as unknown as Chain)
      .is('closed_at', null)
      .eq('region', STATE)
      // The review pile is never shown, the same as everywhere else. Adjacent
      // roles ARE kept — see the file header.
      .not('family', 'is', null)
      .neq('family', 'unsorted')
      .or(windowFilter(cutoff));
    if (workplace) out = out.eq('remote_type', workplace);
    if (seniority) out = out.eq('seniority', seniority);
    if (paidOnly) out = out.not('salary_min', 'is', null);
    if (search) out = out.or(`title.ilike.*${search}*,company.ilike.*${search}*`);
    return out as unknown as T;
  };

  const listQuery = narrow(
    client.from('jobs').select(
      'key,title,company,provider,location,country,region,remote_type,seniority,employment_type,' +
        'salary_min,salary_max,salary_currency,posted_at,first_seen_at,apply_url,family,specialization,adjacent',
      { count: 'exact' },
    ),
  )
    .eq('family', family)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .order('key', { ascending: true })
    .range(offset, offset + limit - 1);

  // The tab counts: one exact count per family, applying the same narrowings
  // minus the family itself, so a tab reads what that tab will actually show.
  // Cheap because the WA subset is small and the (region, family, posted_at)
  // index answers each count without touching the heap — the opposite of the
  // seventeen-count burst that drove Quiet Roles and Institutions to an RPC over
  // their far larger corpora.
  const countQueries = FAMILIES.map((f) =>
    narrow(client.from('jobs').select('key', { count: 'exact', head: true })).eq('family', f),
  );

  const [listResult, ...countResults] = await Promise.all([listQuery, ...countQueries]);
  const { data, error, count } = listResult;

  if (error) {
    // The column is applied by hand like every migration here, so "not yet" is a
    // specific, recoverable state rather than an outage.
    const pending = /column .*region.* does not exist/i.test(error.message);
    console.error('washington feed failed:', error.message);
    return NextResponse.json(
      {
        error: pending
          ? 'Washington roles are not switched on yet — the database migration has not been applied.'
          : 'Washington roles are temporarily unavailable',
      },
      { status: 503 },
    );
  }

  // A count that failed is left OUT, never shown as 0 — a zero reads as "this
  // family has nothing" and sends people away from a tab that is merely
  // uncounted. Mirrors the facet philosophy on the other two pages.
  const counts: Record<string, number> = {};
  let countsOk = true;
  FAMILIES.forEach((f, i) => {
    const r = countResults[i];
    if (r && !r.error && typeof r.count === 'number') counts[f] = r.count;
    else countsOk = false;
  });

  const rows = (data ?? []) as unknown as Row[];
  const now = Date.now();

  const res = NextResponse.json({
    family,
    offset,
    limit,
    matched: count ?? rows.length,
    hasMore: offset + rows.length < (count ?? 0),
    counts,
    // The effective window, so the page's "last N days" reads honestly whether
    // or not a posted-within filter is on.
    maxAgeDays: withinDays,
    jobs: rows.map((r) => {
      const stamp = r.posted_at ?? r.first_seen_at;
      return {
        key: r.key,
        title: r.title,
        company: r.company,
        provider: r.provider,
        location: r.location,
        country: r.country,
        region: r.region,
        remoteType: r.remote_type,
        seniority: r.seniority,
        employmentType: r.employment_type,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        salaryCurrency: r.salary_currency,
        specialization: r.specialization,
        family: r.family,
        adjacent: r.adjacent === true,
        // Undated rows report the age of what we actually know — when we first
        // saw it — and the page labels them as such rather than implying a
        // publish date we were never given.
        ageDays: stamp ? Math.floor((now - Date.parse(stamp)) / 86_400_000) : null,
        dated: r.posted_at !== null,
        applyUrl: r.apply_url,
      };
    }),
  });
  // A page without its counts is cached for seconds, not minutes, so one refused
  // count does not blank the tabs for everyone who follows.
  res.headers.set('cache-control', countsOk ? CACHE_HEADER : DEGRADED_CACHE_HEADER);
  if (!countsOk) res.headers.set('x-facets', 'partial');
  return res;
}
