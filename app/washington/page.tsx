'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FAMILY_LABELS, FAMILY_ORDER, type Family } from '../../src/taxonomy/families.js';
import { SPECIALIZATION_LABELS } from '../../src/taxonomy/specializations.js';
import { WA_DEFAULTS, readFrom, writeTo, type WaFilters } from '../../src/ui/filter-state.js';
import { initialShown, savedScrollY, writeRestorable } from '../../src/ui/restore.js';
import { JobCard } from '../_components/JobCard.js';
import { useJobState } from '../_components/useJobState.js';

/**
 * Washington — every tech role the corpus holds in one US state.
 *
 * A separate page rather than a filter on the main feed, for the same reason
 * Quiet Roles and Institutions are: it answers a different question. The feed
 * asks "what is there?"; this asks "what is there near me?" — and the people it
 * is for, who are tied to a place by a visa, a lease or a family, want the whole
 * of one place rather than a sprinkling of everywhere.
 *
 * Nothing on the main feed changes. This route reads /api/washington, which
 * reads the jobs table directly on an indexed `region` column rather than
 * through feed_page, so no existing query, RPC or component is touched.
 *
 * THE FILTERS ARE THE ONES THE DATA SUPPORTS. Search and seniority as on the
 * other pages; workplace because remote_type is one of four clean values;
 * "states a salary" because 42% of Washington roles carry one — far more than
 * the 16% that made a salary filter dishonest on Quiet Roles. There is no
 * country filter: the page is one country by definition.
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

/** The raw remote_type values, shown in plain words. */
const WORKPLACES: [string, string][] = [
  ['on_site', 'On-site'],
  ['hybrid', 'Hybrid'],
  ['fully_remote', 'Remote'],
];

/** Posted-within windows, in days — the same set the main feed offers. */
const WITHIN: [string, string][] = [
  ['1', '24 hours'],
  ['3', '3 days'],
  ['7', '7 days'],
  ['14', '14 days'],
];

interface WaJob {
  key: string;
  title: string;
  company: string;
  provider: string;
  location: string | null;
  country: string | null;
  region: string | null;
  remoteType: string | null;
  seniority: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  specialization: string | null;
  family: string | null;
  adjacent: boolean;
  ageDays: number | null;
  dated: boolean;
  applyUrl: string | null;
}

interface Payload {
  family: string;
  matched: number;
  hasMore: boolean;
  counts: Record<string, number>;
  maxAgeDays: number;
  jobs: WaJob[];
  error?: string;
}

const PAGE = 50;
/** This page's own key, so the list pages never read each other's place. */
const SCROLL_KEY = 'unsaturated.washington.scroll';

export default function Washington() {
  /** Every choice lives in the address bar, so a view survives a refresh and
   *  can be linked to — the same as the feed and the other two pages. */
  const [filters, setFilters] = useState<WaFilters>(() =>
    typeof window === 'undefined' ? WA_DEFAULTS : readFrom(WA_DEFAULTS, window.location.search),
  );
  // Start at the saved page count when returning to this exact view, so "show
  // more" survives the trip to After applying and back.
  const [shown, setShown] = useState(() => initialShown(SCROLL_KEY, PAGE));
  /** The sidebar, closed on a phone and open on a wide screen, like the feed's. */
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  // Seen/applied marking, the same the main feed has: an opened posting dims.
  const { seen, applied, markApplied } = useJobState();

  /** Family is navigation, so it is not counted as something to clear. */
  const narrowCount = useMemo(
    () =>
      Object.entries(filters).filter(
        ([k, v]) => k !== 'family' && v !== (WA_DEFAULTS as Record<string, unknown>)[k],
      ).length,
    [filters],
  );

  const set = <K extends keyof WaFilters>(key: K, value: WaFilters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    // Changing what you are looking at should start you at the top of it.
    setShown(PAGE);
  };

  // The address bar follows the filters, replacing rather than pushing, so
  // typing in the search box does not bury the back button under one history
  // entry per keystroke.
  useEffect(() => {
    const qs = writeTo(WA_DEFAULTS, filters);
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filters]);

  /** Late responses are discarded — see the note on the same guard in /quiet. */
  const seq = useRef(0);
  /** True until the first load settles, so the scroll is restored once. */
  const restoring = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    const mine = ++seq.current;
    const qs = new URLSearchParams({ family: filters.family, limit: String(shown) });
    if (filters.q.trim()) qs.set('q', filters.q.trim());
    if (filters.seniority) qs.set('seniority', filters.seniority);
    if (filters.workplace) qs.set('workplace', filters.workplace);
    if (filters.postedWithin) qs.set('postedWithin', filters.postedWithin);
    if (filters.paidOnly) qs.set('paidOnly', '1');
    try {
      const res = await fetch(`/api/washington?${qs}`);
      const body = (await res.json()) as Payload;
      if (mine !== seq.current) return;
      if (!res.ok) {
        setFailed(body.error ?? 'Could not load Washington roles.');
        setData(null);
      } else {
        setFailed(null);
        setData(body);
        // Put the reader back where they were, once, after the rows have
        // painted. A different filter set saved nothing, so this is a no-op there.
        if (restoring.current) {
          restoring.current = false;
          const y = savedScrollY(SCROLL_KEY);
          if (y > 0) {
            requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: y })));
          }
        }
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

  // Record the place before leaving or refreshing, so the next load restores it.
  useEffect(() => {
    const remember = () =>
      writeRestorable(SCROLL_KEY, { shown, scrollY: window.scrollY, search: window.location.search });
    window.addEventListener('pagehide', remember);
    document.addEventListener('visibilitychange', remember);
    return () => {
      window.removeEventListener('pagehide', remember);
      document.removeEventListener('visibilitychange', remember);
    };
  }, [shown]);

  const pick = (f: Family) => set('family', f);

  // "All" ('') shows the four real families summed — never the unsorted pile,
  // which keeps its own tab. Hidden rather than shown as 0 when the counts did
  // not arrive, the same rule every tab follows.
  const allCount =
    data && FAMILIES.every((f) => data.counts[f] !== undefined)
      ? FAMILIES.reduce((s, f) => s + (data.counts[f] ?? 0), 0)
      : null;

  /** What is on right now, as removable chips — visible with the sidebar shut. */
  const active: [string, () => void][] = [];
  if (filters.q.trim()) active.push([`“${filters.q.trim()}”`, () => set('q', '')]);
  if (filters.seniority) {
    const label = SENIORITIES.find(([v]) => v === filters.seniority)?.[1] ?? filters.seniority;
    active.push([label, () => set('seniority', '')]);
  }
  if (filters.workplace) {
    const label = WORKPLACES.find(([v]) => v === filters.workplace)?.[1] ?? filters.workplace;
    active.push([label, () => set('workplace', '')]);
  }
  if (filters.postedWithin) {
    const label = WITHIN.find(([v]) => v === filters.postedWithin)?.[1] ?? `${filters.postedWithin} days`;
    active.push([`posted within ${label}`, () => set('postedWithin', '')]);
  }
  if (filters.paidOnly) active.push(['states a salary', () => set('paidOnly', false)]);

  const reset = () => {
    // The family survives a reset — it is where you are, not a narrowing.
    setFilters({ ...WA_DEFAULTS, family: filters.family });
    setShown(PAGE);
  };

  // The view to return to from "After applying": this page WITH its filters.
  const backTo = (() => {
    const qs = writeTo(WA_DEFAULTS, filters);
    return qs ? `/washington?${qs}` : '/washington';
  })();

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
        <a className="navlink inst" href="/institutions">Institutions</a>
        <a className="navlink" href="/">← All roles</a>
      </header>

      {/* Families sit above the layout, exactly as they do on the main feed.
          Same bar, same place, same behaviour. */}
      <nav className="families" aria-label="Role family">
        {/* All = the four real families, never the unsorted pile. */}
        <button
          className={filters.family === '' ? 'on' : ''}
          onClick={() => set('family', '')}
          aria-pressed={filters.family === ''}
        >
          All
          {allCount !== null && <span className="n tnum">{allCount.toLocaleString()}</span>}
        </button>
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
        {/* The review pile, offered by name and deliberately kept out of All. */}
        <button
          className={filters.family === 'unsorted' ? 'fam-unsorted on' : 'fam-unsorted'}
          onClick={() => set('family', 'unsorted')}
          aria-pressed={filters.family === 'unsorted'}
        >
          {FAMILY_LABELS.unsorted}
          {data?.counts?.unsorted !== undefined && (
            <span className="n tnum">{data.counts.unsorted.toLocaleString()}</span>
          )}
        </button>
      </nav>

      <main className="page-washington">
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
              <h2 className="panelhead">Washington</h2>
              <p className="panelnote">
                Every tech role the corpus holds in Washington State — companies,
                universities, hospitals and public bodies alike, from Seattle and
                the Eastside out to Spokane. One place, so you can read all of it
                rather than a few of everywhere.
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
                <label>Seniority</label>
                <select value={filters.seniority} onChange={(e) => set('seniority', e.target.value)}>
                  <option value="">Any</option>
                  {SENIORITIES.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>Workplace</label>
                <select value={filters.workplace} onChange={(e) => set('workplace', e.target.value)}>
                  <option value="">Any</option>
                  {WORKPLACES.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>Posted within</label>
                <select value={filters.postedWithin} onChange={(e) => set('postedWithin', e.target.value)}>
                  <option value="">Any time</option>
                  {WITHIN.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="panel">
              <h3>Narrow to</h3>
              {/* 42% of Washington roles state pay — enough that a toggle hides
                  little, unlike on Quiet Roles. Offered as a toggle, never a
                  range: a minimum-salary slider over partial coverage would hide
                  the rest without saying so. */}
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
                  <b className="tnum">{data.matched.toLocaleString()}</b>{' '}
                  {filters.family && `${FAMILY_LABELS[filters.family as Family].toLowerCase()} `}
                  roles in Washington · last{' '}
                  {data.maxAgeDays === 1 ? '24 hours' : `${data.maxAgeDays} days`}
                </span>
              </div>
            )}

            {/* The pile is lower-confidence by definition — say so rather than
                present it as confirmed tech roles. */}
            {filters.family === 'unsorted' && data && !failed && (
              <p className="panelnote rankednote">
                The review pile — roles the classifier could not confidently sort into a
                family. Likely tech-related, but not guaranteed; shown so nothing in
                Washington is missed.
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
                {narrowCount > 0 ? (
                  <>
                    Nothing matches these choices.{' '}
                    <button className="linkish" onClick={reset}>Clear the narrowing</button> to
                    widen it.
                  </>
                ) : (
                  <>
                    Nothing here yet. State is read from each advert’s location as it
                    is crawled, so this fills in over the next few hours rather than
                    all at once.
                  </>
                )}
              </p>
            )}

            <div className="joblist">
              {data?.jobs.map((j) => (
                <JobCard
                  key={j.key}
                  job={j}
                  backTo={backTo}
                  seen={seen.has(j.key)}
                  applied={applied.has(j.key)}
                  onOpen={() => markApplied(j.key)}
                  chips={
                    <>
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
                      {/* Adjacent roles are kept on this page but said so plainly:
                          a Solutions Engineer is tech-adjacent, not a core role. */}
                      {j.adjacent && <span className="chip adjacent">adjacent</span>}
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
