'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FAMILY_LABELS, FAMILY_ORDER } from '../src/taxonomy/families.js';
import { COUNTRY_LABELS } from '../src/ats/geo.js';

interface Job {
  key: string;
  title: string;
  company: string;
  provider: string;
  location: string | null;
  country: string | null;
  remoteType: string | null;
  seniority: string | null;
  employmentType: string | null;
  department: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  ageDays: number | null;
  applyUrl: string | null;
  components: Record<string, number>;
  family: string | null;
  ai: boolean;
  matchedSkills: string[];
}

/**
 * Resume match, computed in the browser.
 *
 * This used to arrive precomputed on every job, which made the feed response
 * unique per visitor and impossible to cache. The inputs are a list of skills
 * and a list of skills, so doing it here costs nothing and lets the 50-job
 * payload be shared by everyone.
 */
interface Fit {
  score: number;
  known: boolean;
  basis: number;
  have: number;
}

function fitFor(job: Job, skills: string[]): Fit {
  const required = job.matchedSkills ?? [];
  if (required.length === 0 || skills.length === 0) {
    return { score: 0, known: false, basis: required.length, have: 0 };
  }
  const owned = new Set(skills.map((x) => x.toLowerCase()));
  const have = required.filter((x) => owned.has(x.toLowerCase())).length;
  return { score: have / required.length, known: true, basis: required.length, have };
}

interface Me {
  profile: { skills: string[]; resumeChars: number; updatedAt: string | null };
  state: { seen: string[]; applied: string[] };
  /** Null when signed out. Signed-in state follows the account, not the browser. */
  user: { email: string } | null;
}

interface Feed {
  total: number;
  inScope: number;
  matched: number;
  unknownIncluded: { country: number; seniority: number; remote: number; employmentType: number };
  offset: number;
  limit: number;
  shown: number;
  hasMore: boolean;
  maxAgeDays: number;
  refreshedAt: string;
  source?: string;
  boards: { company: string; provider: string; error?: string }[];
  facets: {
    family: Record<string, number>;
    provider: Record<string, number>;
    remote: Record<string, number>;
    country: Record<string, number>;
    countryUnknown?: number;
  };
  jobs: Job[];
}

const SORTS: [string, string][] = [
  ['newest', 'Newest'],
  ['fit', 'Best match'],
  ['salary', 'Salary'],
];

const WORK_LABELS: Record<string, string> = {
  on_site: 'On-site',
  hybrid: 'Hybrid',
  fully_remote: 'Remote',
  unknown: 'Unspecified',
};

function salaryLabel(j: Job): string | null {
  if (!j.salaryMin && !j.salaryMax) return null;
  const k = (v: number | null) => (v && v >= 1000 ? `${Math.round(v / 1000)}k` : v ? String(v) : '');
  const cur = j.salaryCurrency === 'USD' ? '$' : (j.salaryCurrency ?? '');
  const lo = k(j.salaryMin);
  const hi = k(j.salaryMax);
  return `${cur}${lo}${lo && hi ? '–' : ''}${hi}`;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function agoLabel(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

const DEFAULTS = {
  q: '', family: '', country: 'US', remote: '', seniority: '',
  postedWithinDays: '', minFit: '', ai: false, includeUnknown: true, employmentType: '',
  cloudOnly: true, hideGhosts: true, hideSeen: false, sort: 'newest',
};

/** Rows fetched per request. Matches the server default. */
const PAGE_SIZE = 50;

/**
 * Ceiling on a restored view. The API caps a page at 200, and restoring more
 * than that would mean several requests before the first paint — slower than
 * the scroll position is worth.
 */
const MAX_RESTORE = 200;

/**
 * Filters live in the URL, and how far you had scrolled lives in sessionStorage.
 *
 * Without this, coming back to the tab dropped you at the top of an unfiltered
 * first page: filters reset to defaults, the 50-row page reset to one page, and
 * the scroll position was gone. Anyone browsing more than a screen of jobs lost
 * their place every time.
 */
function filtersFromUrl(): typeof DEFAULTS {
  if (typeof window === 'undefined') return DEFAULTS;
  const p = new URLSearchParams(window.location.search);
  const out = { ...DEFAULTS } as Record<string, string | boolean>;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const raw = p.get(k);
    if (raw === null) continue;
    out[k] = typeof v === 'boolean' ? raw === '1' : raw;
  }
  return out as typeof DEFAULTS;
}

const SCROLL_KEY = 'unsaturated.scroll';

interface Restorable {
  /** How many pages had been loaded, so "load more" survives the return trip. */
  pages: number;
  scrollY: number;
  search: string;
}

function readRestorable(): Restorable | null {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    return raw ? (JSON.parse(raw) as Restorable) : null;
  } catch {
    // Private browsing and blocked site data both throw here.
    return null;
  }
}

export default function Page() {
  const [data, setData] = useState<Feed | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState('');
  const [showResume, setShowResume] = useState(false);
  const [filters, setFilters] = useState(filtersFromUrl);
  // Collapsed by default on a phone; the CSS hides the toggle on desktop, where
  // the panels are always shown.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Fetched separately from the feed so the feed itself stays cacheable.
  const [me, setMe] = useState<Me | null>(null);
  // Separate from `me` so a signed-out visitor is distinguishable from one
  // whose check has not finished — otherwise the feed flashes up before the
  // redirect, which looks like a broken page.
  const [meChecked, setMeChecked] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * The resume panel opens at the top of the document, above the sticky header
   * and family nav. Opening it while scrolled down put it off screen, so the
   * button looked broken. Bring the top of the page into view when it opens.
   */
  useEffect(() => {
    if (!showResume) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [showResume]);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch('/api/me');
      if (res.ok) setMe((await res.json()) as Me);
    } catch {
      // Network trouble: leave the gate closed rather than guessing, but do not
      // redirect either — a blip should not throw someone out of the app.
    } finally {
      setMeChecked(true);
    }
  }, []);

  /**
   * Send signed-out visitors to /signin.
   *
   * Deliberately a page-level gate, not an API one. /api/feed is public and
   * cached at the CDN, which is what stopped the feed costing a function
   * invocation per request; making it per-user would undo that, and job
   * postings are public information in any case. What sign-in protects is a
   * person's own resume and applied list, and those endpoints are already
   * scoped to the caller.
   */
  useEffect(() => {
    if (!meChecked || me?.user) return;
    // Carry a magic-link fragment across rather than dropping it.
    //
    // Supabase falls back to the project's Site URL when a redirect target is
    // not on its allow list, which lands a token here instead of on /signin.
    // Redirecting bare would discard the fragment and show the sign-in form
    // again, which looks exactly like the link not working.
    const hash = window.location.hash;
    const carry = hash.includes('access_token=') ? hash : '';
    window.location.replace(`/signin${carry}`);
  }, [meChecked, me]);

  useEffect(() => { void loadMe(); }, [loadMe]);


  async function signOut() {
    await fetch('/api/auth/signout', { method: 'POST' }).catch(() => {});
    window.location.replace('/signin');
  }

  const activeFilterCount = useMemo(
    () =>
      Object.entries(filters).filter(
        ([k, v]) => v !== (DEFAULTS as Record<string, unknown>)[k] && k !== 'sort',
      ).length,
    [filters],
  );

  // Typing in the search box fired one request per keystroke with no ordering
  // guard, so a response for "kube" could land after "kubernetes" and leave the
  // list disagreeing with the box. Every request now carries a sequence number
  // and late arrivals are discarded.
  const reqSeq = useRef(0);

  const seen = useMemo(() => new Set(me?.state.seen ?? []), [me]);
  const applied = useMemo(() => new Set(me?.state.applied ?? []), [me]);

  const paramsFor = useCallback((offset: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'includeUnknown') continue;
      // Visitor-dependent controls never reach the server. Sending them would
      // both 400 (the feed has no 'fit' sort any more) and split the CDN cache
      // into a separate entry per visitor, which is the thing this split exists
      // to prevent.
      if (k === 'hideSeen' || k === 'minFit') continue;
      if (k === 'sort' && v === 'fit') continue;
      if (v === '' || v === false) continue;
      p.set(k, v === true ? '1' : String(v));
    }
    // Sent only when turned off, since the server keeps unknowns by default.
    if (!filters.includeUnknown) p.set('includeUnknown', '0');
    if (offset > 0) p.set('offset', String(offset));
    return p;
  }, [filters]);

  const restoring = useRef(true);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);

    // On the first load after coming back, ask for every page that was open
    // rather than just the first, or "load more" is silently undone.
    let want = PAGE_SIZE;
    let restoreTo = 0;
    if (restoring.current) {
      restoring.current = false;
      const saved = readRestorable();
      if (saved && saved.search === window.location.search && saved.pages > 1) {
        want = Math.min(saved.pages * PAGE_SIZE, MAX_RESTORE);
        restoreTo = saved.scrollY;
      } else if (saved && saved.search === window.location.search) {
        restoreTo = saved.scrollY;
      }
    }

    try {
      const res = await fetch(`/api/feed?${paramsFor(0)}&limit=${want}`);
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `request failed (${res.status})`);
      }
      const body = (await res.json()) as Feed;
      if (seq !== reqSeq.current) return; // a newer request has already answered
      setData(body);
      setJobs(body.jobs);
      if (restoreTo > 0) {
        // After paint, or the page is still short and the scroll goes nowhere.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.scrollTo({ top: restoreTo })),
        );
      }
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setError(err instanceof Error ? err.message : 'could not load jobs');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [paramsFor]);

  /** Appends the next page. The list used to stop dead at 200 with no way on. */
  const loadMore = useCallback(async () => {
    if (!data?.hasMore || moreBusy) return;
    setMoreBusy(true);
    try {
      const res = await fetch(`/api/feed?${paramsFor(jobs.length)}`);
      if (!res.ok) throw new Error('could not load more');
      const body = (await res.json()) as Feed;
      setJobs((prev) => [...prev, ...body.jobs]);
      setData(body);
    } catch {
      // Leave what is already on screen; the button stays available to retry.
    } finally {
      setMoreBusy(false);
    }
  }, [data, jobs.length, moreBusy, paramsFor]);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Keep the address bar in step with the controls. replaceState rather than
  // pushState: every filter change becoming a history entry would make the back
  // button walk through them one at a time instead of leaving the site.
  useEffect(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v === (DEFAULTS as Record<string, unknown>)[k]) continue;
      p.set(k, v === true ? '1' : v === false ? '0' : String(v));
    }
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filters]);

  // Record the position before the tab is hidden or unloaded, so returning from
  // a job posting lands where it left off.
  useEffect(() => {
    const remember = () => {
      try {
        sessionStorage.setItem(
          SCROLL_KEY,
          JSON.stringify({
            pages: Math.max(1, Math.ceil(jobs.length / PAGE_SIZE)),
            scrollY: window.scrollY,
            search: window.location.search,
          }),
        );
      } catch {
        // Blocked site data — the feed still works, the position is just lost.
      }
    };
    window.addEventListener('pagehide', remember);
    document.addEventListener('visibilitychange', remember);
    return () => {
      window.removeEventListener('pagehide', remember);
      document.removeEventListener('visibilitychange', remember);
    };
  }, [jobs.length]);

  async function saveResume() {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/profile', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resume }),
      });
      // The response used to be discarded, so a save that failed on the server
      // closed the panel and looked exactly like one that worked.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setSaveError(body?.error ?? 'could not save your resume');
        return;
      }
      setShowResume(false);
      await loadMe();
    } catch {
      setSaveError('could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function open(job: Job) {
    await fetch('/api/state', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: job.key, action: 'applied' }),
    }).catch(() => {});
    void loadMe();
  }

  const set = (k: string, v: string | boolean) => setFilters((f) => ({ ...f, [k]: v }));
  const toggle = (k: 'remote' | 'family', v: string) =>
    setFilters((f) => ({ ...f, [k]: f[k] === v ? '' : v }));

  const skills = me?.profile.skills ?? [];
  const facets = data?.facets;

  /**
   * Filters and ordering that depend on the visitor.
   *
   * These used to run on the server, which is what made every feed response
   * unique and uncacheable. They apply to the rows already loaded — so hiding
   * seen jobs shortens the current page rather than pulling replacements, which
   * is the honest behaviour anyway.
   */
  const visible = useMemo(() => {
    let rows = jobs;
    if (filters.hideSeen) rows = rows.filter((j) => !seen.has(j.key));
    const floor = filters.minFit === '' ? null : Number(filters.minFit);
    if (floor !== null && Number.isFinite(floor) && skills.length > 0) {
      // Jobs we cannot score are never dropped by a match threshold.
      rows = rows.filter((j) => {
        const f = fitFor(j, skills);
        return !f.known || f.score >= floor;
      });
    }
    if (filters.sort === 'fit' && skills.length > 0) {
      rows = [...rows].sort((a, b) => {
        const fa = fitFor(a, skills);
        const fb = fitFor(b, skills);
        // Discounted by how many skills the posting actually named, so 100%
        // against one skill does not outrank 100% against ten.
        const wa = fa.known ? fa.score * Math.min(1, fa.basis / 5) : -1;
        const wb = fb.known ? fb.score * Math.min(1, fb.basis / 5) : -1;
        return wb - wa;
      });
    }
    return rows;
  }, [jobs, filters.hideSeen, filters.minFit, filters.sort, seen, skills]);

  // Nothing of the feed renders until we know who is asking.
  if (!meChecked || !me?.user) {
    return <div className="authgate">Loading…</div>;
  }

  return (
    <>
      <header>
        <h1 className="brand"><span className="dot" />Unsaturated</h1>
        {data && (
          <div className="hstats">
            <span><b className="tnum">{data.inScope.toLocaleString()}</b> in corpus</span>
            <span><b className="tnum">{data.total.toLocaleString()}</b> scanned</span>
            <span>last {data.maxAgeDays} days</span>
            <span>updated {ago(data.refreshedAt)}</span>
            {/* A frozen build snapshot used to be indistinguishable from live data. */}
            {data.source === 'snapshot' && <span className="unk">from snapshot</span>}
          </div>
        )}
        <div className="grow" />
        <button onClick={() => setShowResume((s) => !s)}>
          {skills.length ? `Skills · ${skills.length}` : 'Add resume'}
        </button>
        {me?.user && (
          <button onClick={() => void signOut()} title={me.user.email}>
            {me.user.email.split('@')[0]} · sign out
          </button>
        )}
      </header>

      {/* Families are the primary navigation now that ranking is by recency. */}
      <nav className="families">
        <button className={filters.family === '' ? 'on' : ''} onClick={() => set('family', '')}>
          All
          <span className="n">{Object.values(facets?.family ?? {}).reduce((a, b) => a + b, 0)}</span>
        </button>
        {FAMILY_ORDER.map((f) => (
          <button key={f} className={filters.family === f ? 'on' : ''} onClick={() => toggle('family', f)}>
            {FAMILY_LABELS[f]}
            <span className="n">{facets?.family?.[f] ?? 0}</span>
          </button>
        ))}
      </nav>

      <main>
        {showResume && (
          <div className="panel" style={{ marginBottom: 14 }}>
            <h3>Resume</h3>
            <p className="note">
              Paste your resume to get match percentages. Keywords are extracted and the
              <b> skill list is saved to this browser</b> so it survives a reload — the resume
              text itself is not kept, only its length.
            </p>
            <textarea
              value={resume} onChange={(e) => setResume(e.target.value)}
              placeholder="Paste resume text…"
            />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              {saveError && <p className="hint">{saveError}</p>}
              <button className="primary" onClick={() => void saveResume()} disabled={busy}>
                Extract skills
              </button>
              <div className="chips" style={{ margin: 0 }}>
                {skills.map((s) => <span className="chip skill" key={s}>{s}</span>)}
              </div>
            </div>
          </div>
        )}

        <div className="layout">
          <aside className={`sidebar${filtersOpen ? '' : ' collapsed'}`}>
            {/* Visible only under 940px — see globals.css. */}
            <button
              className="filtertoggle"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <span>Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}</span>
              <span>{filtersOpen ? '▲' : '▼'}</span>
            </button>
            <div className="panel">
              <div className="field">
                <input
                  type="text" placeholder="Search title, company, city"
                  value={filters.q} onChange={(e) => set('q', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Country</label>
                <select value={filters.country} onChange={(e) => set('country', e.target.value)}>
                  <option value="">Anywhere</option>
                  {Object.entries(facets?.country ?? {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([c, n]) => (
                      <option key={c} value={c}>
                        {(COUNTRY_LABELS as Record<string, string>)[c] ?? c} ({n})
                      </option>
                    ))}
                  {/* Its own option rather than being folded into every country.
                      Picking "United States" used to return 3,204 jobs whose
                      country we could not read, so the count was wrong and the
                      label was a lie. */}
                  {(facets?.countryUnknown ?? 0) > 0 && (
                    <option value="__unknown__">
                      Location unclear ({facets?.countryUnknown})
                    </option>
                  )}
                </select>
              </div>
              <div className="field">
                <label>Seniority</label>
                <select value={filters.seniority} onChange={(e) => set('seniority', e.target.value)}>
                  <option value="">Any</option>
                  {['entry', 'senior', 'staff', 'principal', 'lead', 'director'].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Employment type</label>
                <select value={filters.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
                  <option value="">Any</option>
                  <option value="fulltime">Full-time</option>
                  <option value="contract">Contract</option>
                  <option value="parttime">Part-time</option>
                  <option value="intern">Internship</option>
                </select>
              </div>
              <div className="field">
                <label>Posted within</label>
                <select value={filters.postedWithinDays} onChange={(e) => set('postedWithinDays', e.target.value)}>
                  <option value="">Any time</option>
                  <option value="1">24 hours</option>
                  <option value="3">3 days</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                </select>
              </div>
            </div>

            <div className="panel">
              <h3>Work setup</h3>
              <div className="facet">
                {Object.entries(facets?.remote ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => (
                    <button key={k} className={filters.remote === k ? 'on' : ''} onClick={() => toggle('remote', k)}>
                      <span>{WORK_LABELS[k] ?? k}</span><span className="n">{n}</span>
                    </button>
                  ))}
              </div>
            </div>

            <div className="panel">
              <h3>Refine</h3>
              {skills.length > 0 && (
                <div className="field">
                  <label>Minimum match</label>
                  <select value={filters.minFit} onChange={(e) => set('minFit', e.target.value)}>
                    <option value="">Any</option>
                    <option value="0.3">30%+</option>
                    <option value="0.5">50%+</option>
                    <option value="0.7">70%+</option>
                  </select>
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={filters.ai} onChange={(e) => set('ai', e.target.checked)} />
                AI / ML roles only
              </label>
              <label className="check">
                <input type="checkbox" checked={filters.includeUnknown}
                  onChange={(e) => set('includeUnknown', e.target.checked)} />
                Include jobs with missing details
              </label>
              <label className="check">
                <input type="checkbox" checked={filters.hideGhosts}
                  onChange={(e) => set('hideGhosts', e.target.checked)} />
                Hide likely ghost jobs
              </label>
              <label className="check">
                <input type="checkbox" checked={filters.hideSeen}
                  onChange={(e) => set('hideSeen', e.target.checked)} />
                Hide ones I&apos;ve opened
              </label>
            </div>
          </aside>

          <section>
            <div className="results">
              <span className="count">
                <b className="tnum">{data?.matched ?? 0}</b> roles
                {filters.family && ` · ${FAMILY_LABELS[filters.family as never] ?? filters.family}`}
                {(() => {
                  const u = data?.unknownIncluded;
                  const n = (u?.country ?? 0) + (u?.seniority ?? 0) + (u?.remote ?? 0) + (u?.employmentType ?? 0);
                  return n > 0 ? <span className="unk"> · includes {n} with unknown details</span> : null;
                })()}
                {data && jobs.length < data.matched && (
                  <span className="unk"> · showing {visible.length}</span>
                )}
              </span>
              <div className="grow" />
              <div className="sorts">
                {SORTS.map(([k, label]) => (
                  <button key={k} className={filters.sort === k ? 'on' : ''} onClick={() => set('sort', k)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {error ? (
              <div className="empty">
                {error}
                <div style={{ marginTop: 12 }}>
                  <button onClick={() => { void load(); }}>Try again</button>
                </div>
              </div>
            ) : loading ? (
              <>{[0, 1, 2, 3, 4].map((i) => <div className="skeleton" key={i} />)}</>
            ) : jobs.length === 0 ? (
              <div className="empty">
                No roles match these filters.
                <div style={{ marginTop: 12 }}>
                  <button onClick={() => setFilters(DEFAULTS)}>Reset filters</button>
                </div>
              </div>
            ) : (
              visible.map((j) => {
                const pay = salaryLabel(j);
                const fresh = j.ageDays !== null && j.ageDays <= 2;
                return (
                  <article
                    className={`job ${seen.has(j.key) ? 'seen' : ''}${applied.has(j.key) ? ' applied' : ''}`}
                    key={j.key}
                  >
                    <div className="body">
                      <div className="jobhead">
                        <div className="title">
                          {j.applyUrl
                            ? <a href={j.applyUrl} target="_blank" rel="noopener noreferrer" onClick={() => void open(j)}>{j.title}</a>
                            : j.title}
                        </div>
                        <div className={`age ${fresh ? 'fresh' : ''}`}>{agoLabel(j.ageDays)}</div>
                      </div>

                      <div className="meta">
                        <span className="co">{j.company}</span>
                        <span className="sep">·</span>
                        {j.location ?? <span className="unk">location not specified</span>}
                      </div>

                      <div className="chips">
                        {j.family && (
                          <span className="chip fam">
                            {(FAMILY_LABELS as Record<string, string>)[j.family] ?? j.family}
                          </span>
                        )}
                        {j.ai && <span className="chip ai">AI / ML</span>}
                        <span className={`chip${j.remoteType ? '' : ' unknown'}`}>
                          {j.remoteType ? (WORK_LABELS[j.remoteType] ?? j.remoteType) : 'work type unknown'}
                        </span>
                        <span className={`chip${j.seniority ? '' : ' unknown'}`}>
                          {j.seniority ?? 'level unknown'}
                        </span>
                        {j.employmentType && <span className="chip">{j.employmentType}</span>}
                        {pay && <span className="chip pay">{pay}</span>}
                        {applied.has(j.key) && <span className="chip appliedchip">applied</span>}
                        {(() => {
                          const f = fitFor(j, skills);
                          return f.known ? (
                            <span className="chip match">
                              {Math.round(f.score * 100)}% match · {f.have}/{f.basis}
                            </span>
                          ) : null;
                        })()}
                        {(j.components.ghostRisk ?? 0) >= 0.4 && (
                          <span className="chip ghost">possible ghost job</span>
                        )}
                      </div>

                      {j.matchedSkills.length > 0 && (
                        <div className="chips">
                          {j.matchedSkills.slice(0, 10).map((s) => (
                            <span className="chip skill" key={s}>{s}</span>
                          ))}
                        </div>
                      )}

                      <div className="actions">
                        {j.applyUrl && (
                          <a href={j.applyUrl} target="_blank" rel="noopener noreferrer" onClick={() => void open(j)}>
                            Open posting ↗
                          </a>
                        )}
                        <span className="src">{j.provider}</span>
                      </div>
                    </div>
                  </article>
                );
              })
            )}

            {/* Without this the list stopped at 200 rows with no way forward, so
                everything posted more than a few days ago was unreachable. */}
            {!loading && !error && data?.hasMore && (
              <div className="more">
                <button onClick={() => { void loadMore(); }} disabled={moreBusy}>
                  {moreBusy ? 'Loading…' : `Load more · ${data.matched - jobs.length} left`}
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
