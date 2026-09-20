'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FAMILY_LABELS, FAMILY_ORDER, type Family } from '../../src/taxonomy/families.js';
import { SPECIALIZATION_LABELS } from '../../src/taxonomy/specializations.js';
import { COUNTRY_LABELS } from '../../src/ats/geo.js';
import { QUIET_DEFAULTS, readFrom, writeTo, type QuietFilters } from '../../src/ui/filter-state.js';
import { JobCard } from '../_components/JobCard.js';

/**
 * Quiet Roles — the same work, filed under a title nobody searches.
 *
 * A separate page rather than a filter on the main feed, because it answers a
 * different question. The feed asks "what is there?"; this asks "what is there
 * that nobody else is looking at?" — and the two want different defaults, a
 * different sort and, above all, a different frame of mind.
 *
 * Nothing on the main feed changes. This route reads /api/quiet, which reads the
 * jobs table directly rather than through feed_page, so no existing query, RPC
 * or component is touched by any of it.
 *
 * THE FILTERS ADDED ON 20 SEPTEMBER 2026 are the ones the data supports and no
 * others. Country because the corpus is 6,581 American roles against 675
 * British ones in a single undifferentiated list; search because seven thousand
 * software roles cannot be read; seniority because it is known for 56% of them.
 * Employment type was measured and deliberately left out: the stored values are
 * raw vendor text — "Full-Time", "Full time", "permanent / full-time", and one
 * literal "__" — so a filter would quietly show a fraction of what matches.
 */

const FAMILIES = FAMILY_ORDER.filter((f) => f !== 'unsorted') as Family[];

const SENIORITIES: [string, string][] = [
  ['entry', 'Entry'],
  ['mid', 'Mid'],
  ['senior', 'Senior'],
  ['lead', 'Lead'],
  ['staff', 'Staff'],
  ['principal', 'Principal'],
];

interface QuietJob {
  key: string;
  title: string;
  company: string;
  provider: string;
  location: string | null;
  country: string | null;
  remoteType: string | null;
  seniority: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  specialization: string | null;
  ageDays: number | null;
  dated: boolean;
  applyUrl: string | null;
  reasons: string[];
  quietScore: number;
}

interface Payload {
  family: string;
  matched: number;
  hasMore: boolean;
  sort?: string;
  rankedPool?: number;
  rankedCapped?: boolean;
  counts: Record<string, number>;
  countries: Record<string, number>;
  countryUnknown: number;
  maxAgeDays: number;
  jobs: QuietJob[];
  error?: string;
}

const PAGE = 50;

export default function QuietRoles() {
  /**
   * Every choice lives in the address bar.
   *
   * Before this the page forgot all of it on refresh: filters back to default,
   * "show 50 more" back to one page, and no way to link anyone to a view.
   */
  const [filters, setFilters] = useState<QuietFilters>(() =>
    typeof window === 'undefined'
      ? QUIET_DEFAULTS
      : readFrom(QUIET_DEFAULTS, window.location.search),
  );
  const [shown, setShown] = useState(PAGE);

  /**
   * The sidebar, collapsed on a phone.
   *
   * Open on a wide screen and closed on a narrow one, which is what the main feed
   * does — without it a phone scrolls past the whole control panel before reaching
   * a single job.
   */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  /** Family is navigation, so it is not counted as something to clear. */
  const narrowCount = useMemo(
    () =>
      Object.entries(filters).filter(
        ([k, v]) =>
          k !== 'family' && k !== 'sort' && v !== (QUIET_DEFAULTS as Record<string, unknown>)[k],
      ).length,
    [filters],
  );

  const set = <K extends keyof QuietFilters>(key: K, value: QuietFilters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    // Changing what you are looking at should start you at the top of it.
    setShown(PAGE);
  };

  // The address bar follows the filters, replacing rather than pushing: typing
  // in the search box should not bury the back button under forty history
  // entries, one per keystroke.
  useEffect(() => {
    const qs = writeTo(QUIET_DEFAULTS, filters);
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filters]);

  /**
   * Typing fires one request per keystroke, and responses can arrive out of
   * order — the main feed had a list disagreeing with its own search box for
   * exactly that reason. Every request carries a sequence number and a late
   * arrival is discarded.
   */
  const seq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const mine = ++seq.current;
    const qs = new URLSearchParams({ family: filters.family, limit: String(shown) });
    if (filters.q.trim()) qs.set('q', filters.q.trim());
    if (filters.country) qs.set('country', filters.country);
    if (filters.seniority) qs.set('seniority', filters.seniority);
    if (filters.onSite) qs.set('onSite', '1');
    if (filters.noEntry) qs.set('noEntry', '1');
    if (filters.midMarket) qs.set('midMarket', '1');
    if (filters.paidOnly) qs.set('paidOnly', '1');
    if (filters.sort !== 'newest') qs.set('sort', filters.sort);
    try {
      const res = await fetch(`/api/quiet?${qs}`);
      const body = (await res.json()) as Payload;
      if (mine !== seq.current) return;
      if (!res.ok) {
        setFailed(body.error ?? 'Could not load quiet roles.');
        setData(null);
      } else {
        setFailed(null);
        setData(body);
      }
    } catch {
      if (mine === seq.current) setFailed('Could not reach the server.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [filters, shown]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = (f: Family) => set('family', f);

  /** What is on right now, as removable chips — visible with the sidebar shut. */
  const active: [string, () => void][] = [];
  if (filters.q.trim()) active.push([`“${filters.q.trim()}”`, () => set('q', '')]);
  if (filters.country) {
    active.push([
      filters.country === '__unknown__'
        ? 'location unclear'
        : ((COUNTRY_LABELS as Record<string, string>)[filters.country] ?? filters.country),
      () => set('country', ''),
    ]);
  }
  if (filters.seniority) {
    const label = SENIORITIES.find(([v]) => v === filters.seniority)?.[1] ?? filters.seniority;
    active.push([label, () => set('seniority', '')]);
  }
  if (filters.onSite) active.push(['not fully remote', () => set('onSite', false)]);
  if (filters.noEntry) active.push(['not entry level', () => set('noEntry', false)]);
  if (filters.midMarket) active.push(['rarely-syndicated board', () => set('midMarket', false)]);
  if (filters.paidOnly) active.push(['states a salary', () => set('paidOnly', false)]);

  const reset = () => {
    // The family survives a reset. It is where you are, not a narrowing, and
    // being thrown back to Cloud for clearing a search box is disorienting.
    setFilters({ ...QUIET_DEFAULTS, family: filters.family });
    setShown(PAGE);
  };

  return (
    <>
      <header>
        <h1 className="brand">
          <svg className="mark" viewBox="0 0 32 24" aria-hidden="true" focusable="false">
            <circle className="crowd" cx="4" cy="5" r="2.0" opacity="0.55" />
            <circle className="crowd" cx="10" cy="3" r="1.6" opacity="0.40" />
            <circle className="crowd" cx="3" cy="12" r="1.6" opacity="0.45" />
            <circle className="crowd" cx="9" cy="10" r="2.0" opacity="0.55" />
            <circle className="crowd" cx="5" cy="19" r="1.6" opacity="0.40" />
            <circle className="crowd" cx="12" cy="17" r="1.5" opacity="0.35" />
            <circle className="ring" cx="21" cy="12" r="6.2" fill="none" strokeWidth="1.3" />
            <circle className="open" cx="21" cy="12" r="3.4" />
          </svg>
          Unsaturated
        </h1>
        <div className="grow" />
        <a className="navlink inst" href="/institutions">Institutions</a>
        <a className="navlink" href="/">← All roles</a>
      </header>

      {/* Families sit above the layout, exactly as they do on the main feed.
          They are navigation, not a filter, and putting them in the sidebar here
          while they are a top bar there is what made the two pages feel like
          different products. */}
      <nav className="families" aria-label="Role family">
        {FAMILIES.map((f) => (
          <button
            key={f}
            className={f === filters.family ? `fam-${f} on` : `fam-${f}`}
            onClick={() => pick(f)}
            aria-pressed={f === filters.family}
          >
            {FAMILY_LABELS[f]}
            {data?.counts?.[f] !== undefined && (
              <span className="n tnum">{data.counts[f]!.toLocaleString()}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="page-quiet">
        <div className="layout">
          <aside className={`sidebar${filtersOpen ? '' : ' collapsed'}`}>
            {/* Visible only under 940px, like the feed's. Without it a phone
                scrolls past the whole control panel before reaching a job. */}
            <button
              className="filtertoggle"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <span>Narrow{narrowCount > 0 ? ` · ${narrowCount}` : ''}</span>
              <span>{filtersOpen ? '▲' : '▼'}</span>
            </button>

            <div className="panel">
              <h2 className="panelhead">Quiet roles</h2>
              <p className="panelnote">
                The same work, advertised under a title people do not search for. A
                “Cloud Operations Analyst” and a “Cloud Engineer” can be the same
                job — but only one of them is what everybody types into the box.
              </p>
            </div>

            <div className="panel">
              <div className="field">
                <input
                  type="text"
                  placeholder="Search title or employer"
                  value={filters.q}
                  onChange={(e) => set('q', e.target.value)}
                />
              </div>

              <div className="field">
                <label>Country</label>
                <select value={filters.country} onChange={(e) => set('country', e.target.value)}>
                  <option value="">Anywhere</option>
                  {Object.entries(data?.countries ?? {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([c, n]) => (
                      <option key={c} value={c}>
                        {(COUNTRY_LABELS as Record<string, string>)[c] ?? c} ({n.toLocaleString()})
                      </option>
                    ))}
                {/* Its own option rather than being folded into every country.
                    A fifth of the corpus has no country on it, and adding those
                    to whichever country was picked makes the count beside it
                    wrong and the label a lie — the exact mistake the main feed
                    made and corrected. */}
                {(data?.countryUnknown ?? 0) > 0 && (
                  <option value="__unknown__">
                    Location unclear ({data?.countryUnknown?.toLocaleString()})
                  </option>
                )}
                </select>
              </div>

              <div className="field">
                <label>Seniority</label>
                <select value={filters.seniority} onChange={(e) => set('seniority', e.target.value)}>
                  <option value="">Any</option>
                  {SENIORITIES.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Each of these is a real, measurable reason fewer people see a role —
                not a preference. They are off by default so the page opens with the
                widest honest answer. */}
            <div className="panel">
              <h3>Quieter still</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={filters.onSite}
                  onChange={() => set('onSite', !filters.onSite)}
                />
                not fully remote
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={filters.noEntry}
                  onChange={() => set('noEntry', !filters.noEntry)}
                />
                not entry level
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={filters.midMarket}
                  onChange={() => set('midMarket', !filters.midMarket)}
                />
                rarely-syndicated board
              </label>
              {/* 16% of quiet roles state pay. Offered as a toggle and never as
                  a range: a minimum-salary slider over 16% coverage would hide
                  the other 84% without saying so. */}
              <label className="check">
                <input
                  type="checkbox"
                  checked={filters.paidOnly}
                  onChange={() => set('paidOnly', !filters.paidOnly)}
                />
                states a salary
              </label>
            </div>

            {narrowCount > 0 && (
              <div className="panel">
                <button className="resetfilters" onClick={reset}>Clear narrowing</button>
              </div>
            )}
          </aside>

          <section>
            {failed && <p className="empty">{failed}</p>}

            {data && !failed && (
              <div className="results">
                <span className="count">
                  <b className="tnum">{data.matched.toLocaleString()}</b> quiet{' '}
                  {FAMILY_LABELS[filters.family as Family].toLowerCase()} roles · last{' '}
                  {data.maxAgeDays} days
                </span>
                <div className="grow" />
                <div className="sorts">
                  <button
                    className={filters.sort === 'newest' ? 'on' : ''}
                    onClick={() => set('sort', 'newest')}
                  >
                    Newest
                  </button>
                  <button
                    className={filters.sort === 'quietest' ? 'on' : ''}
                    onClick={() => set('sort', 'quietest')}
                  >
                    Quietest
                  </button>
                </div>
              </div>
            )}

            {/* Said plainly rather than implied. Ranking reads the title with a
                regex, which cannot be run across the whole corpus per request,
                so it ranks the most recent 500 and says so. */}
            {data?.rankedCapped && (
              <p className="panelnote rankednote">
                Quietest first, ranked within the {data.rankedPool} most recent of{' '}
                {data.matched.toLocaleString()}.
              </p>
            )}

            {active.length > 0 && (
              <div className="activefilters">
                {active.map(([label, clear]) => (
                  <button key={label} className="activechip" onClick={clear}>
                    {label}
                    <span aria-hidden="true"> ×</span>
                    <span className="sr-only"> — remove this filter</span>
                  </button>
                ))}
                <button className="clearall" onClick={reset}>Clear all</button>
              </div>
            )}

            {loading && !data && <p className="empty">Loading…</p>}

            {data && data.jobs.length === 0 && !loading && (
              <p className="empty">
                Nothing quiet here right now.
                {narrowCount > 0 && (
                  <>
                    {' '}
                    <button className="linkish" onClick={reset}>Clear the narrowing</button> to
                    widen it.
                  </>
                )}
              </p>
            )}

            <div className="joblist">
              {data?.jobs.map((j) => (
                <JobCard
                  key={j.key}
                  job={j}
                  score={j.quietScore}
                  reasons={j.reasons}
                  chips={
                    <>
                      <span className={`chip fam fam-${filters.family}`}>
                        {FAMILY_LABELS[filters.family as Family]}
                      </span>
                      {j.specialization && SPECIALIZATION_LABELS[j.specialization as never] && (
                        <span className="chip spec">
                          {SPECIALIZATION_LABELS[j.specialization as never]}
                        </span>
                      )}
                    </>
                  }
                />
              ))}
            </div>

            {data?.hasMore && (
              <div className="more">
                <button onClick={() => setShown((n) => n + PAGE)} disabled={loading}>
                  {loading ? 'Loading…' : `Show ${PAGE} more`}
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
