import { NextResponse } from 'next/server';
import { db } from '../../../src/db/supabase.js';
import { MAX_AGE_DAYS } from '../../../src/corpus/types.js';
import { FAMILY_ORDER } from '../../../src/taxonomy/families.js';
import { quietReasons, quietScore, SYNDICATED_PROVIDERS } from '../../../src/taxonomy/quiet.js';

/**
 * The Quiet Roles feed.
 *
 * A separate route from /api/feed on purpose. That one goes through feed_page,
 * an RPC whose signature cannot gain a parameter without dropping and
 * recreating it — which is how this project once nearly took the site down. The
 * quiet page needs one extra condition and nothing else, so it reads the table
 * directly and leaves every existing code path untouched.
 *
 * `quiet` is a stored generated column, so the filter is an indexed boolean
 * rather than a regex evaluated per request. Matching the magnet pattern live
 * was measured at a statement timeout over the real corpus.
 */
export const dynamic = 'force-dynamic';

const FAMILIES = FAMILY_ORDER.filter((f) => f !== 'unsorted');
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const CACHE_HEADER = 'public, s-maxage=60, stale-while-revalidate=300';

interface Row {
  key: string;
  title: string;
  company: string;
  provider: string;
  location: string | null;
  country: string | null;
  remote_type: string | null;
  seniority: string | null;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  posted_at: string | null;
  first_seen_at: string | null;
  apply_url: string | null;
  specialization: string | null;
}

/**
 * The same window the main feed uses, expressed the same way.
 *
 * Undated rows are bounded by when we first saw them rather than waved through.
 * Waving them through is what once made "past 24 hours" show postings four days
 * old, and the quiet page must not reintroduce it.
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

  // The three optional narrowings, each a real reason fewer people see a role.
  const onSite = p.get('onSite') === '1';
  const noEntry = p.get('noEntry') === '1';
  const midMarket = p.get('midMarket') === '1';

  if (bad.length > 0) {
    return NextResponse.json({ error: 'invalid query', details: bad }, { status: 400 });
  }

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
  const client = db();

  const base = () => {
    let q = client
      .from('jobs')
      .select(
        'key,title,company,provider,location,country,remote_type,seniority,employment_type,' +
          'salary_min,salary_max,salary_currency,posted_at,first_seen_at,apply_url,specialization',
        { count: 'exact' },
      )
      .is('closed_at', null)
      .eq('quiet', true)
      // Adjacent roles are already a deliberate opt-in elsewhere; a page about
      // finding good roles under bad titles should not quietly widen the
      // definition of the family as well.
      .eq('adjacent', false)
      .or(windowFilter(cutoff));
    if (onSite) q = q.neq('remote_type', 'fully_remote');
    if (noEntry) q = q.neq('seniority', 'entry');
    if (midMarket) q = q.not('provider', 'in', `(${SYNDICATED_PROVIDERS.join(',')})`);
    return q;
  };

  const { data, error, count } = await base()
    .eq('family', family)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .order('key', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    // The generated column is applied by hand like every other migration here,
    // so "column does not exist" is a specific, recoverable state and worth
    // saying plainly rather than reporting as a general outage.
    const pending = /column .*quiet.* does not exist/i.test(error.message);
    console.error('quiet feed failed:', error.message);
    return NextResponse.json(
      {
        error: pending
          ? 'Quiet roles are not switched on yet — the database migration has not been applied.'
          : 'Quiet roles are temporarily unavailable',
      },
      { status: 503 },
    );
  }

  const rows = (data ?? []) as unknown as Row[];
  const now = Date.now();

  // One count per family, for the tabs. Cheap: HEAD requests against the same
  // partial index the page query uses.
  const counts: Record<string, number> = {};
  await Promise.all(
    FAMILIES.map(async (f) => {
      const { count: n } = await base().eq('family', f).range(0, 0);
      counts[f] = n ?? 0;
    }),
  );

  const res = NextResponse.json({
    family,
    offset,
    limit,
    matched: count ?? rows.length,
    hasMore: offset + rows.length < (count ?? 0),
    counts,
    maxAgeDays: MAX_AGE_DAYS,
    jobs: rows.map((r) => {
      const stamp = r.posted_at ?? r.first_seen_at;
      return {
        key: r.key,
        title: r.title,
        company: r.company,
        provider: r.provider,
        location: r.location,
        country: r.country,
        remoteType: r.remote_type,
        seniority: r.seniority,
        employmentType: r.employment_type,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        salaryCurrency: r.salary_currency,
        specialization: r.specialization,
        // Undated rows report the age of what we actually know — when we first
        // saw it — and the page labels them as such rather than implying a
        // publish date we were never given.
        ageDays: stamp ? Math.floor((now - Date.parse(stamp)) / 86_400_000) : null,
        dated: r.posted_at !== null,
        applyUrl: r.apply_url,
        reasons: quietReasons({
          title: r.title,
          provider: r.provider,
          remoteType: r.remote_type,
          seniority: r.seniority,
        }),
        quietScore: quietScore({
          title: r.title,
          provider: r.provider,
          remoteType: r.remote_type,
          seniority: r.seniority,
        }),
      };
    }),
  });
  res.headers.set('cache-control', CACHE_HEADER);
  return res;
}
