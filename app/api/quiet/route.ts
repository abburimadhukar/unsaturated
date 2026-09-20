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

/**
 * The countries offered in the dropdown, and the only ones counted.
 *
 * COUNTRY_LABELS holds ninety-odd, and counting all of them would mean ninety
 * round trips on every request to populate a list that is empty for most of
 * them. These are the ones the quiet corpus measurably has, on 20 September
 * 2026: US 6,581 · IN 1,796 · GB 675 · CA 592 · DE 317 · PL 251 · SG 147 ·
 * AU 185 · NL 118 · IE 108. A country with nothing in it is dropped from the
 * response rather than shown as a dead option.
 */
const COUNTRY_FACETS = ['US', 'GB', 'IN', 'CA', 'DE', 'AU', 'NL', 'IE', 'PL', 'SG', 'FR', 'ES'];

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

  /**
   * Where the work is. The single largest gap on this page.
   *
   * Measured 20 September 2026 the quiet corpus is 6,581 US roles, 1,796
   * Indian, 675 British and 592 Canadian, all in one undifferentiated list —
   * so a British reader scrolled past ten American roles for every British one.
   *
   * A fifth of the rows carry no country at all, and '__unknown__' selects
   * exactly those. Its own option rather than being folded into every country,
   * which is the shape the main feed arrived at the hard way: picking "United
   * States" there once returned 3,204 postings whose country could not be read,
   * so the count beside the option was wrong and the label was a lie. A
   * dropdown that reads "United Kingdom (206)" has to return 206.
   */
  const country = (p.get('country') ?? '').trim();
  const UNPLACED = '__unknown__';
  if (country && country !== UNPLACED && !/^[A-Z]{2}$/.test(country.toUpperCase())) {
    bad.push('country must be a two-letter code');
  }

  /** Title and employer. Postgres `ilike`, so the commas and parens that would
   *  otherwise break PostgREST's filter grammar are stripped rather than sent. */
  const search = (p.get('q') ?? '').trim().slice(0, 80).replace(/[(),*]/g, ' ').trim();

  const seniority = (p.get('seniority') ?? '').trim();
  const SENIORITIES = ['entry', 'mid', 'senior', 'staff', 'principal', 'lead'];
  if (seniority && !SENIORITIES.includes(seniority)) {
    bad.push(`seniority must be one of ${SENIORITIES.join(', ')}`);
  }

  const paidOnly = p.get('paidOnly') === '1';

  /**
   * 'quietest' sorts by how hard the role is to find, which is this page's
   * whole subject and was computed for every row and then never used — the
   * list only ever came back newest-first. It is not a stored column, so it
   * cannot be an ORDER BY; see the sort below.
   */
  const sort = p.get('sort') ?? 'newest';
  if (!['newest', 'quietest'].includes(sort)) bad.push('sort must be newest or quietest');

  if (bad.length > 0) {
    return NextResponse.json({ error: 'invalid query', details: bad }, { status: 400 });
  }

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000).toISOString();
  const client = db();

  /**
   * The matching set.
   *
   * `withPlace` is false when counting the countries themselves: a facet that
   * had the chosen country applied to it as well would report the size of the
   * intersection of a country with itself, and every other country as zero.
   */
  const base = ({ withPlace = true }: { withPlace?: boolean } = {}) => {
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
    if (seniority) q = q.eq('seniority', seniority);
    if (paidOnly) q = q.not('salary_min', 'is', null);
    if (search) q = q.or(`title.ilike.*${search}*,company.ilike.*${search}*`);
    if (withPlace && country) {
      q = country === UNPLACED ? q.is('country', null) : q.eq('country', country.toUpperCase());
    }
    return q;
  };

  /**
   * Quietest-first is ranked here, not by the database.
   *
   * quietScore reads the title with a regex, and matching it across the whole
   * corpus per request was measured at a statement timeout — the same reason
   * `quiet` is a stored column rather than a live pattern. So the sort takes
   * the most recent POOL rows that match and ranks those. It is bounded and it
   * is stated on the page: "quietest first, from the newest 500". Claiming to
   * rank 7,000 rows while actually ranking 50 would be the dishonest version.
   */
  const POOL = 500;
  const ranked = sort === 'quietest';

  const { data, error, count } = await base()
    .eq('family', family)
    .order('posted_at', { ascending: false, nullsFirst: false })
    .order('key', { ascending: true })
    .range(ranked ? 0 : offset, ranked ? POOL - 1 : offset + limit - 1);

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

  const all = (data ?? []) as unknown as Row[];
  const now = Date.now();

  const scoreOf = (r: Row) =>
    quietScore({ title: r.title, provider: r.provider, remoteType: r.remote_type, seniority: r.seniority });

  // Ranked mode sorts the pool and then pages inside it; newest mode has
  // already been paged by the database and is left exactly as it arrived.
  const rows = ranked
    ? [...all].sort((a, b) => scoreOf(b) - scoreOf(a) || a.key.localeCompare(b.key))
        .slice(offset, offset + limit)
    : all;

  /** In ranked mode the reachable set is the pool, not the whole match. */
  const reachable = ranked ? Math.min(count ?? all.length, POOL) : (count ?? all.length);

  // One count per family, for the tabs. Cheap: HEAD requests against the same
  // partial index the page query uses.
  //
  // The family counts deliberately ignore the country and the search box: they
  // are navigation, and a tab that reads 0 because of a filter set on another
  // tab is how someone concludes the page is broken.
  const counts: Record<string, number> = {};
  const countries: Record<string, number> = {};
  let countryUnknown = 0;
  await Promise.all([
    ...FAMILIES.map(async (f) => {
      const { count: n } = await base({ withPlace: false }).eq('family', f).range(0, 0);
      counts[f] = n ?? 0;
    }),
    // Only the countries the corpus actually has enough of to be worth
    // offering, counted within the family being looked at so the number beside
    // each one is the number you will get.
    ...COUNTRY_FACETS.map(async (c) => {
      const { count: n } = await base({ withPlace: false }).eq('family', family).eq('country', c).range(0, 0);
      if (n) countries[c] = n;
    }),
    (async () => {
      const { count: n } = await base({ withPlace: false })
        .eq('family', family)
        .is('country', null)
        .range(0, 0);
      countryUnknown = n ?? 0;
    })(),
  ]);

  const res = NextResponse.json({
    family,
    offset,
    limit,
    matched: count ?? rows.length,
    hasMore: offset + rows.length < reachable,
    sort,
    // So the page can say "from the newest 500" rather than implying the rank
    // covers everything matched.
    ...(ranked ? { rankedPool: POOL, rankedCapped: (count ?? 0) > POOL } : {}),
    counts,
    countries,
    countryUnknown,
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
