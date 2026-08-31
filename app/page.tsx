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
  fit: number;
  fitKnown: boolean;
  fitBasis: number;
  fitHave: string[];
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
  };
  profile: { skills: string[] };
  state: { seen: string[]; applied: string[] };
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
const PAGE_SIZE = 200;

export default function Page() {
  const [data, setData] = useState<Feed | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState('');
  const [showResume, setShowResume] = useState(false);
  const [filters, setFilters] = useState(DEFAULTS);

  // Typing in the search box fired one request per keystroke with no ordering
  // guard, so a response for "kube" could land after "kubernetes" and leave the
  // list disagreeing with the box. Every request now carries a sequence number
  // and late arrivals are discarded.
  const reqSeq = useRef(0);

  const seen = useMemo(() => new Set(data?.state.seen ?? []), [data]);

  const paramsFor = useCallback((offset: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'includeUnknown') continue;
      if (v === '' || v === false) continue;
      p.set(k, v === true ? '1' : String(v));
    }
    // Sent only when turned off, since the server keeps unknowns by default.
    if (!filters.includeUnknown) p.set('includeUnknown', '0');
    if (offset > 0) p.set('offset', String(offset));
    return p;
  }, [filters]);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/feed?${paramsFor(0)}`);
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `request failed (${res.status})`);
      }
      const body = (await res.json()) as Feed;
      if (seq !== reqSeq.current) return; // a newer request has already answered
      setData(body);
      setJobs(body.jobs);
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

  async function saveResume() {
    setBusy(true);
    await fetch('/api/profile', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume }),
    });
    setShowResume(false);
    await load();
    setBusy(false);
  }

  async function open(job: Job) {
    await fetch('/api/state', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: job.key, action: 'applied' }),
    }).catch(() => {});
    void load();
  }

  const set = (k: string, v: string | boolean) => setFilters((f) => ({ ...f, [k]: v }));
  const toggle = (k: 'remote' | 'family', v: string) =>
    setFilters((f) => ({ ...f, [k]: f[k] === v ? '' : v }));

  const skills = data?.profile.skills ?? [];
  const facets = data?.facets;

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
          <aside className="sidebar">
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
                  <span className="unk"> · showing {jobs.length}</span>
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
              jobs.map((j) => {
                const pay = salaryLabel(j);
                const fresh = j.ageDays !== null && j.ageDays <= 2;
                return (
                  <article className={`job ${seen.has(j.key) ? 'seen' : ''}`} key={j.key}>
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
                        {skills.length > 0 && j.fitKnown && (
                          <span className="chip match">
                            {Math.round(j.fit * 100)}% match · {j.fitHave.length}/{j.fitBasis}
                          </span>
                        )}
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
