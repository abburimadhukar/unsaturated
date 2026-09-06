import { NextResponse } from 'next/server';
import { db } from '../../../src/db/supabase.js';
import { MAX_AGE_DAYS } from '../../../src/corpus/types.js';
import { FAMILY_ORDER } from '../../../src/taxonomy/families.js';
import { SECTOR_ORDER, type Sector } from '../../../src/taxonomy/sector.js';

/**
 * Roles at universities, hospitals, charities and public bodies.
 *
 * Its own route for the same reason /api/quiet is: feed_page cannot gain a
 * parameter without being dropped and recreated, and this needs one extra
 * condition and nothing else. Reading the table directly leaves every existing
 * code path untouched.
 *
 * Sector cuts ACROSS families rather than replacing them — a hospital hires
 * cloud engineers and data analysts alike — so family is a filter here, not the
 * top-level axis.
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
  sector: string | null;
  quiet?: boolean | null;
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const bad: string[] = [];

  const sectorRaw = p.get('sector');
  if (sectorRaw && !SECTOR_ORDER.includes(sectorRaw as Sector)) {
    bad.push(`sector must be one of ${SECTOR_ORDER.join(', ')}`);
  }
  const familyRaw = p.get('family');
  if (familyRaw && !FAMILIES.includes(familyRaw as (typeof FAMILIES)[number])) {
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
  const quietOnly = p.get('quietOnly') === '1';

  if (bad.length > 0) {
    return NextResponse.json({ error: 'invalid query', details: bad }, { status: 400 });
  }

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
  const client = db();

  const base = () => {
    let q = client
      .from('jobs')
      .select(
        'key,title,company,provider,location,remote_type,seniority,employment_type,' +
          'salary_min,salary_max,salary_currency,posted_at,first_seen_at,apply_url,family,sector,quiet',
        { count: 'exact' },
      )
      .is('closed_at', null)
      .not('sector', 'is', null)
      .not('family', 'is', null)
      .eq('adjacent', false)
      .or(`posted_at.gte.${cutoff},and(posted_at.is.null,first_seen_at.gte.${cutoff})`);
    if (familyRaw) q = q.eq('family', familyRaw);
    // The two pages compose: an institution role that is also under a title
    // nobody searches for is the quietest thing on the site.
    if (quietOnly) q = q.eq('quiet', true);
    return q;
  };

  let page = base();
  if (sectorRaw) page = page.eq('sector', sectorRaw);

  const { data, error, count } = await page
    .order('posted_at', { ascending: false, nullsFirst: false })
    .order('key', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    // Both columns are applied by hand like every migration here, so "not yet"
    // is a specific, recoverable state rather than an outage.
    const pending = /column .*(sector|quiet).* does not exist/i.test(error.message);
    console.error('institutions feed failed:', error.message);
    return NextResponse.json(
      {
        error: pending
          ? 'Institutions are not switched on yet — the database migration has not been applied.'
          : 'Institution roles are temporarily unavailable',
      },
      { status: 503 },
    );
  }

  const rows = (data ?? []) as unknown as Row[];
  const now = Date.now();

  const counts: Record<string, number> = {};
  await Promise.all(
    SECTOR_ORDER.map(async (s) => {
      const { count: n } = await base().eq('sector', s).range(0, 0);
      counts[s] = n ?? 0;
    }),
  );

  const res = NextResponse.json({
    sector: sectorRaw,
    family: familyRaw,
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
        remoteType: r.remote_type,
        seniority: r.seniority,
        employmentType: r.employment_type,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        salaryCurrency: r.salary_currency,
        family: r.family,
        sector: r.sector,
        quiet: r.quiet === true,
        ageDays: stamp ? Math.floor((now - Date.parse(stamp)) / 86_400_000) : null,
        dated: r.posted_at !== null,
        applyUrl: r.apply_url,
      };
    }),
  });
  res.headers.set('cache-control', CACHE_HEADER);
  return res;
}
