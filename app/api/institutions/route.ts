import { NextResponse } from 'next/server';
import { db } from '../../../src/db/supabase.js';
import { MAX_AGE_DAYS } from '../../../src/corpus/types.js';
import { FAMILY_ORDER } from '../../../src/taxonomy/families.js';
import { SECTOR_ORDER, type Sector } from '../../../src/taxonomy/sector.js';
import { pageFacets } from '../../../src/corpus/page-facets.js';

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

/** The same shortlist /api/quiet offers, for the same reason. */
const COUNTRY_FACETS = ['US', 'GB', 'IN', 'CA', 'DE', 'AU', 'NL', 'IE', 'PL', 'SG', 'FR', 'ES'];

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const CACHE_HEADER = 'public, s-maxage=60, stale-while-revalidate=300';
/** Same reasoning as the main feed's: seconds, not no-store, so a busy database is not stampeded. */
const DEGRADED_CACHE_HEADER = 'public, s-maxage=5';

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
  country: string | null;
  specialization: string | null;
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

  /**
   * Where the work is. '__unknown__' selects the rows we could not place.
   *
   * Its own option rather than being folded into every country, which is the
   * shape the main feed arrived at the hard way: picking "United States" there
   * once returned 3,204 postings whose country could not be read, so the count
   * beside the option was wrong and the label was a lie. A dropdown that reads
   * "United Kingdom (206)" has to return 206.
   */
  const country = (p.get('country') ?? '').trim();
  const UNPLACED = '__unknown__';
  if (country && country !== UNPLACED && !/^[A-Z]{2}$/.test(country.toUpperCase())) {
    bad.push('country must be a two-letter code');
  }

  const search = (p.get('q') ?? '').trim().slice(0, 80).replace(/[(),*]/g, ' ').trim();

  /**
   * Offered here and not on Quiet Roles, because the data only supports it
   * here. Measured 20 September 2026: 68% of institution roles carry a
   * specialization against 17% of quiet ones. A dropdown that silently hides
   * five sixths of the page is worse than no dropdown.
   */
  const specialization = (p.get('specialization') ?? '').trim();
  if (specialization && !/^[a-z_]{2,40}$/.test(specialization)) {
    bad.push('specialization is not a known value');
  }

  if (bad.length > 0) {
    return NextResponse.json({ error: 'invalid query', details: bad }, { status: 400 });
  }

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
  const client = db();

  /**
   * The matching set for the list itself. The counts are institution_facets'
   * job, and it applies the same conditions — keep the two in step.
   */
  const base = () => {
    let q = client
      .from('jobs')
      .select(
        'key,title,company,provider,location,country,remote_type,seniority,employment_type,' +
          'salary_min,salary_max,salary_currency,posted_at,first_seen_at,apply_url,family,sector,' +
          'specialization,quiet',
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
    if (specialization) q = q.eq('specialization', specialization);
    if (search) q = q.or(`title.ilike.*${search}*,company.ilike.*${search}*`);
    if (country) {
      q = country === UNPLACED ? q.is('country', null) : q.eq('country', country.toUpperCase());
    }
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

  /**
   * Every count on the page, in ONE query (institution_facets).
   *
   * These used to be a request per sector, per country and for "location
   * unclear", all at once, followed by a paged read of every matching row's
   * specialization to tally in JavaScript. See 2026-09-25-page-facets.sql.
   *
   * What each count ignores is unchanged, and now lives in the SQL:
   *  - the sector tabs ignore the country and the chosen sector — they are
   *    navigation, and a tab reading 0 because of a filter set elsewhere is how
   *    someone concludes the page is broken;
   *  - the countries are counted without the country itself applied, or every
   *    other country would read zero;
   *  - the specialization list ignores the specialization and search filters,
   *    for the same reason as the tabs.
   *
   * If the counts fail they are left OUT, not set to 0. The page hides a count
   * it was not given; a zero would be an invented number.
   */
  const facets = await pageFacets('institution_facets', {
    p_cutoff: cutoff,
    p_family: familyRaw || null,
    p_quiet: quietOnly,
    p_specialization: specialization || null,
    p_q: search || null,
    p_sector: sectorRaw || null,
  });
  const counts: Record<string, number> = {};
  const countries: Record<string, number> = {};
  if (facets) {
    for (const s of SECTOR_ORDER) counts[s] = facets.counts[s] ?? 0;
    // Only the shortlist is offered, as before; an empty country is dropped.
    for (const c of COUNTRY_FACETS) if (facets.countries[c]) countries[c] = facets.countries[c]!;
  }
  const specializations = facets?.specializations ?? {};

  const res = NextResponse.json({
    sector: sectorRaw,
    family: familyRaw,
    offset,
    limit,
    matched: count ?? rows.length,
    hasMore: offset + rows.length < (count ?? 0),
    counts,
    countries,
    countryUnknown: facets?.countryUnknown ?? 0,
    specializations,
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
        country: r.country,
        specialization: r.specialization,
        family: r.family,
        sector: r.sector,
        quiet: r.quiet === true,
        ageDays: stamp ? Math.floor((now - Date.parse(stamp)) / 86_400_000) : null,
        dated: r.posted_at !== null,
        applyUrl: r.apply_url,
      };
    }),
  });
  // A page without its counts is cached for seconds, not minutes, so one
  // refused count does not blank the tabs for everyone who follows.
  res.headers.set('cache-control', facets ? CACHE_HEADER : DEGRADED_CACHE_HEADER);
  if (!facets) res.headers.set('x-facets', 'unavailable');
  return res;
}
