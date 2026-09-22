'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FAMILY_LABELS, FAMILY_ORDER, type Family } from '../../src/taxonomy/families.js';
import { SECTOR_LABELS, SECTOR_ORDER, type Sector } from '../../src/taxonomy/sector.js';
import { SPECIALIZATION_LABELS } from '../../src/taxonomy/specializations.js';
import { COUNTRY_LABELS } from '../../src/ats/geo.js';
import { INST_DEFAULTS, readFrom, writeTo, type InstFilters } from '../../src/ui/filter-state.js';
import { JobCard } from '../_components/JobCard.js';

/**
 * Roles at universities, hospitals, charities and public bodies.
 *
 * These employers are structurally short of technical staff — 66% of health-IT
 * professionals report persistent shortages, and university technology leaders
 * lose candidates to tech firms on pay and flexibility. Fewer applicants per
 * posting, for reasons that are not going to change.
 *
 * Sector cuts ACROSS the families rather than replacing them: a hospital hires
 * cloud engineers and data analysts alike. So sector is the top-level choice
 * here and family narrows within it, which is the opposite of Quiet Roles.
 *
 * FEWER FILTERS THAN QUIET ROLES, on purpose. This page is 1,431 roles against
 * that page's 17,536, and a filter that takes 1,431 to nothing is not a feature.
 * Specialization is offered HERE and not there because 68% of institution roles
 * carry one against 17% of quiet ones — the same control, honest on one page
 * and misleading on the other.
 */

const FAMILIES = FAMILY_ORDER.filter((f) => f !== 'unsorted') as Family[];
const PAGE = 50;

interface InstJob {
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
  family: string | null;
  sector: string | null;
  quiet: boolean;
  ageDays: number | null;
  dated: boolean;
  applyUrl: string | null;
}

interface Payload {
  matched: number;
  hasMore: boolean;
  counts: Record<string, number>;
  countries: Record<string, number>;
  countryUnknown: number;
  specializations: Record<string, number>;
  maxAgeDays: number;
  jobs: InstJob[];
  error?: string;
}

export default function Institutions() {
  const [filters, setFilters] = useState<InstFilters>(() =>
    typeof window === 'undefined' ? INST_DEFAULTS : readFrom(INST_DEFAULTS, window.location.search),
  );
  const [shown, setShown] = useState(PAGE);
  /** The sidebar, closed on a phone and open on a wide screen, like the feed's. */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  /** Sector is the page's navigation, so it does not count as a narrowing. */
  const narrowCount = useMemo(
    () =>
      Object.entries(filters).filter(
        ([k, v]) => k !== 'sector' && v !== (INST_DEFAULTS as Record<string, unknown>)[k],
      ).length,
    [filters],
  );

  const set = <K extends keyof InstFilters>(key: K, value: InstFilters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setShown(PAGE);
  };

  useEffect(() => {
    const qs = writeTo(INST_DEFAULTS, filters);
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filters]);

  /** Late responses are discarded — see the note on the same guard in /quiet. */
  const seq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const mine = ++seq.current;
    const qs = new URLSearchParams({ limit: String(shown) });
    if (filters.sector) qs.set('sector', filters.sector);
    if (filters.family) qs.set('family', filters.family);
    if (filters.q.trim()) qs.set('q', filters.q.trim());
    if (filters.country) qs.set('country', filters.country);
    if (filters.specialization) qs.set('specialization', filters.specialization);
    if (filters.quietOnly) qs.set('quietOnly', '1');
    try {
      const res = await fetch(`/api/institutions?${qs}`);
      const body = (await res.json()) as Payload;
      if (mine !== seq.current) return;
      if (!res.ok) {
        setFailed(body.error ?? 'Could not load institution roles.');
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

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : null;

  const active: [string, () => void][] = [];
  if (filters.family) {
    active.push([FAMILY_LABELS[filters.family as Family], () => set('family', '')]);
  }
  if (filters.q.trim()) active.push([`“${filters.q.trim()}”`, () => set('q', '')]);
  if (filters.country) {
    active.push([
      filters.country === '__unknown__'
        ? 'location unclear'
        : ((COUNTRY_LABELS as Record<string, string>)[filters.country] ?? filters.country),
      () => set('country', ''),
    ]);
  }
  if (filters.specialization) {
    active.push([
      SPECIALIZATION_LABELS[filters.specialization as never] ?? filters.specialization,
      () => set('specialization', ''),
    ]);
  }
  if (filters.quietOnly) active.push(['quiet titles only', () => set('quietOnly', false)]);

  const reset = () => {
    setFilters({ ...INST_DEFAULTS, sector: filters.sector });
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
        <a className="navlink quiet" href="/quiet">Quiet roles</a>
        <a className="navlink" href="/">← All roles</a>
      </header>

      {/* Sectors sit above the layout, where the main feed puts its families.
          Same bar, same place, same behaviour — the thing that made these pages
          feel like separate products was that their primary navigation lived
          somewhere else. */}
      <nav className="families" aria-label="Sector">
        <button className={filters.sector === '' ? 'on' : ''} onClick={() => set('sector', '')}>
          All
          {total !== null && <span className="n tnum">{total.toLocaleString()}</span>}
        </button>
        {SECTOR_ORDER.map((s) => (
          <button
            key={s}
            className={s === filters.sector ? 'on' : ''}
            onClick={() => set('sector', s)}
            aria-pressed={s === filters.sector}
          >
            {SECTOR_LABELS[s]}
            {data?.counts?.[s] !== undefined && (
              <span className="n tnum">{data.counts[s]!.toLocaleString()}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="page-inst">
        <div className="layout">
          <aside className={`sidebar${filtersOpen ? '' : ' collapsed'}`}>
            <button
              className="filtertoggle"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <span>Narrow{narrowCount > 0 ? ` · ${narrowCount}` : ''}</span>
              <span>{filtersOpen ? '▲' : '▼'}</span>
            </button>

            <div className="panel">
              <h2 className="panelhead">Institutions</h2>
              <p className="panelnote">
                Universities, hospitals, charities and public bodies. They hire the
                same engineers as everyone else and lose candidates to tech firms on
                pay and flexibility — so their postings sit longer and draw fewer
                people.
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

              {/* Built from what this sector actually holds, so it never offers
                  an option that returns nothing. */}
              {Object.keys(data?.specializations ?? {}).length > 1 && (
                <div className="field">
                  <label>Kind of work</label>
                  <select
                    value={filters.specialization}
                    onChange={(e) => set('specialization', e.target.value)}
                  >
                    <option value="">Any</option>
                    {Object.entries(data?.specializations ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([s, n]) => (
                        <option key={s} value={s}>
                          {SPECIALIZATION_LABELS[s as never] ?? s} ({n})
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>

            <div className="panel">
              <h3>Narrow to</h3>
              <div className="chips pickchips">
                {FAMILIES.map((f) => (
                  <button
                    key={f}
                    className={`pick${filters.family === f ? ' on' : ''}`}
                    onClick={() => set('family', filters.family === f ? '' : f)}
                    aria-pressed={filters.family === f}
                  >
                    {FAMILY_LABELS[f]}
                  </button>
                ))}
              </div>

              {/* The two pages compose. An institution role ALSO under a title
                  nobody searches for is the least contested thing on the site. */}
              <label className="check">
                <input
                  type="checkbox"
                  checked={filters.quietOnly}
                  onChange={() => set('quietOnly', !filters.quietOnly)}
                />
                quiet titles only
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
                  <b className="tnum">{data.matched.toLocaleString()}</b>{' '}
                  {filters.sector
                    ? SECTOR_LABELS[filters.sector as Sector].toLowerCase()
                    : 'institution'}{' '}
                  roles · last {data.maxAgeDays} days
                </span>
              </div>
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
                {narrowCount > 0 ? (
                  <>
                    Nothing matches these choices.{' '}
                    <button className="linkish" onClick={reset}>Clear the narrowing</button> to
                    widen it.
                  </>
                ) : (
                  <>
                    Nothing here yet. Sector is read from each advert as it is crawled, so
                    this fills in over the next few hours rather than all at once.
                  </>
                )}
              </p>
            )}

            <div className="joblist">
              {data?.jobs.map((j) => (
                <JobCard
                  key={j.key}
                  job={j}
                  backTo="/institutions"
                  chips={
                    <>
                      {j.sector && <span className="chip sector">{SECTOR_LABELS[j.sector as Sector]}</span>}
                      {j.family && (
                        <span className={`chip fam fam-${j.family}`}>
                          {FAMILY_LABELS[j.family as Family]}
                        </span>
                      )}
                      {j.specialization && SPECIALIZATION_LABELS[j.specialization as never] && (
                        <span className="chip spec">
                          {SPECIALIZATION_LABELS[j.specialization as never]}
                        </span>
                      )}
                      {j.quiet && <span className="chip quiet">quiet title</span>}
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
