'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLE_FAMILY_LABELS } from '../src/taxonomy/cloud.js';
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
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  ageDays: number | null;
  applyUrl: string | null;
  saturation: number;
  components: Record<string, number>;
  reasons: string[];
  family: string | null;
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
  maxAgeDays: number;
  refreshedAt: string;
  source?: string;
  boards: { company: string; provider: string; jobs: number; kept: number; error?: string }[];
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

const AXES: [string, string][] = [
  ['discoveryFriction', 'discover'],
  ['applicationFriction', 'friction'],
  ['qualificationFriction', 'qualify'],
  ['desirabilityDiscount', 'desire'],
  ['freshness', 'fresh'],
];

const SORTS: [string, string][] = [
  ['saturation', 'Least contested'],
  ['newest', 'Newest'],
  ['fit', 'Best fit'],
  ['salary', 'Salary'],
];

const WORK_LABELS: Record<string, string> = {
  on_site: 'On-site',
  hybrid: 'Hybrid',
  fully_remote: 'Remote',
  unknown: 'Unspecified',
};

/** Score colour is the product's core signal — green means uncontested. */
function scoreColor(n: number): string {
  if (n >= 65) return 'var(--hot)';
  if (n >= 45) return 'var(--warm)';
  return 'var(--cool)';
}

function ScoreRing({ value }: { value: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const color = scoreColor(value);
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden>
      <circle cx="24" cy="24" r={r} fill="none" stroke="var(--raised)" strokeWidth="3.5" />
      <circle
        cx="24" cy="24" r={r} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(100, value)) / 100)}
      />
      <text
        x="24" y="24" transform="rotate(90 24 24)"
        textAnchor="middle" dominantBaseline="central"
        fill={color} fontSize="15" fontWeight="680"
        style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em' }}
      >
        {value}
      </text>
    </svg>
  );
}

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
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const EMPTY_FILTERS = {
  q: '', country: 'US', remote: '', family: '', seniority: '',
  minSaturation: '', minFit: '', postedWithinDays: '',
  cloudOnly: true, hideGhosts: true, hideSeen: false, sort: 'saturation',
};

export default function Page() {
  const [data, setData] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState('');
  const [showResume, setShowResume] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const seen = useMemo(() => new Set(data?.state.seen ?? []), [data]);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v === '' || v === false) continue;
      p.set(k, v === true ? '1' : String(v));
    }
    if (!filters.cloudOnly) p.set('cloudOnly', '0');
    const res = await fetch(`/api/feed?${p}`);
    setData((await res.json()) as Feed);
    setLoading(false);
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  async function refresh() {
    setBusy(true);
    await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
    await load();
    setBusy(false);
  }

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

  // Opening a posting is treated as engagement; it dims the card so the feed
  // reads as a worklist rather than an undifferentiated wall.
  async function open(job: Job) {
    await fetch('/api/state', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: job.key, action: 'applied' }),
    }).catch(() => {});
    void load();
  }

  const set = (k: string, v: string | boolean) => setFilters((f) => ({ ...f, [k]: v }));
  const toggle = (k: 'remote' | 'family' | 'country', v: string) =>
    setFilters((f) => ({ ...f, [k]: f[k] === v ? '' : v }));

  const skills = data?.profile.skills ?? [];
  const facets = data?.facets;

  return (
    <>
      <header>
        <h1 className="brand"><span className="dot" />Unsaturated</h1>
        {data && (
          <div className="hstats">
            <span><b className="tnum">{data.inScope}</b> cloud roles</span>
            <span><b className="tnum">{data.total.toLocaleString()}</b> scanned</span>
            <span><b>{data.boards.filter((b) => !b.error).length}</b> boards</span>
            <span>updated {ago(data.refreshedAt)}</span>
          </div>
        )}
        <div className="grow" />
        <button onClick={() => setShowResume((s) => !s)}>
          {skills.length ? `Skills · ${skills.length}` : 'Add resume'}
        </button>
        {data?.source !== 'snapshot' && (
          <button onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Working…' : 'Refresh'}
          </button>
        )}
      </header>

      <main>
        {showResume && (
          <div className="panel" style={{ marginBottom: 14 }}>
            <h3>Resume</h3>
            <p className="note">
              Paste your resume. Skills are matched by keyword <b>in your browser session only</b> —
              nothing is stored on disk or sent anywhere else.
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
                <label>Posted within</label>
                <select
                  value={filters.postedWithinDays}
                  onChange={(e) => set('postedWithinDays', e.target.value)}
                >
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
                    <button
                      key={k} className={filters.remote === k ? 'on' : ''}
                      onClick={() => toggle('remote', k)}
                    >
                      <span>{WORK_LABELS[k] ?? k}</span><span className="n">{n}</span>
                    </button>
                  ))}
              </div>
            </div>

            <div className="panel">
              <h3>Role family</h3>
              <div className="facet">
                {Object.entries(facets?.family ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => (
                    <button
                      key={k} className={filters.family === k ? 'on' : ''}
                      onClick={() => toggle('family', k)}
                    >
                      <span>{(ROLE_FAMILY_LABELS as Record<string, string>)[k] ?? k}</span>
                      <span className="n">{n}</span>
                    </button>
                  ))}
              </div>
            </div>

            <div className="panel">
              <h3>Thresholds</h3>
              <div className="field">
                <label>Minimum score</label>
                <select value={filters.minSaturation} onChange={(e) => set('minSaturation', e.target.value)}>
                  <option value="">Any</option>
                  <option value="45">45+</option>
                  <option value="60">60+</option>
                  <option value="70">70+ (least contested)</option>
                </select>
              </div>
              {skills.length > 0 && (
                <div className="field">
                  <label>Minimum fit</label>
                  <select value={filters.minFit} onChange={(e) => set('minFit', e.target.value)}>
                    <option value="">Any</option>
                    <option value="0.3">30%+</option>
                    <option value="0.5">50%+</option>
                    <option value="0.7">70%+</option>
                  </select>
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={filters.cloudOnly}
                  onChange={(e) => set('cloudOnly', e.target.checked)} />
                Cloud roles only
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

            {data && (
              <div className="panel">
                <h3>Sources</h3>
                <div className="health">
                  {Object.entries(data.facets.provider)
                    .sort((a, b) => b[1] - a[1])
                    .map(([p, n]) => <div key={p}>{p} · {n}</div>)}
                  {data.boards.filter((b) => b.error).length > 0 && (
                    <div className="err" style={{ marginTop: 6 }}>
                      {data.boards.filter((b) => b.error).length} board(s) failing
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>

          <section>
            <div className="results">
              <span className="count">
                <b className="tnum">{data?.matched ?? 0}</b> roles
                {filters.country && ` in ${(COUNTRY_LABELS as Record<string, string>)[filters.country] ?? filters.country}`}
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

            <p className="note">
              <b>Score</b> measures how <b>uncontested</b> a role is — higher means fewer people are
              likely applying. It is not a measure of whether you are qualified; that is the separate
              fit number. Last {data?.maxAgeDays ?? 30} days only.
            </p>

            {loading ? (
              <>{[0, 1, 2, 3, 4].map((i) => <div className="skeleton" key={i} />)}</>
            ) : !data || data.jobs.length === 0 ? (
              <div className="empty">
                No roles match these filters.
                <div style={{ marginTop: 12 }}>
                  <button onClick={() => setFilters(EMPTY_FILTERS)}>Reset filters</button>
                </div>
              </div>
            ) : (
              data.jobs.map((j) => {
                const pay = salaryLabel(j);
                return (
                  <article className={`job ${seen.has(j.key) ? 'seen' : ''}`} key={j.key}>
                    <div className="ring">
                      <ScoreRing value={j.saturation} />
                      <div className="cap">uncontested</div>
                      {skills.length > 0 && (
                        <div className="fitline">
                          {j.fitKnown ? <><b>{Math.round(j.fit * 100)}%</b> fit<br />{j.fitHave.length}/{j.fitBasis}</> : 'no desc'}
                        </div>
                      )}
                    </div>

                    <div className="body">
                      <div className="title">
                        {j.applyUrl
                          ? <a href={j.applyUrl} target="_blank" rel="noopener noreferrer" onClick={() => void open(j)}>{j.title}</a>
                          : j.title}
                      </div>
                      <div className="meta">
                        <span className="co">{j.company}</span>
                        {j.location && <><span className="sep">·</span>{j.location}</>}
                      </div>

                      <div className="chips">
                        {j.family && (
                          <span className="chip fam">
                            {(ROLE_FAMILY_LABELS as Record<string, string>)[j.family] ?? j.family}
                          </span>
                        )}
                        {j.remoteType && <span className="chip">{WORK_LABELS[j.remoteType] ?? j.remoteType}</span>}
                        {j.seniority && <span className="chip">{j.seniority}</span>}
                        {j.ageDays !== null && (
                          <span className={`chip${j.ageDays <= 2 ? ' fresh' : ''}`}>
                            {j.ageDays === 0 ? 'today' : `${j.ageDays}d ago`}
                          </span>
                        )}
                        {pay && <span className="chip pay">{pay}</span>}
                        {(j.components.ghostRisk ?? 0) >= 0.4 && (
                          <span className="chip ghost">
                            ghost risk {Math.round((j.components.ghostRisk ?? 0) * 100)}%
                          </span>
                        )}
                      </div>

                      <div className="bars">
                        {AXES.map(([key, cap]) => (
                          <div className="bar" key={key}>
                            <div className="track">
                              <div className="fill" style={{ width: `${Math.round((j.components[key] ?? 0) * 100)}%` }} />
                            </div>
                            <div className="cap">{cap}</div>
                          </div>
                        ))}
                      </div>

                      {j.matchedSkills.length > 0 && (
                        <div className="chips">
                          {j.matchedSkills.slice(0, 9).map((s) => (
                            <span className="chip skill" key={s}>{s}</span>
                          ))}
                        </div>
                      )}

                      {j.reasons.length > 0 && (
                        <div className="reasons">{j.reasons.slice(0, 3).join(' · ')}</div>
                      )}

                      <div className="actions">
                        {j.applyUrl && (
                          <a href={j.applyUrl} target="_blank" rel="noopener noreferrer" onClick={() => void open(j)}>
                            Open posting ↗
                          </a>
                        )}
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{j.provider}</span>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </section>
        </div>
      </main>
    </>
  );
}
