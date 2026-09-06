'use client';

import { useCallback, useEffect, useState } from 'react';
import { FAMILY_LABELS, FAMILY_ORDER, type Family } from '../../src/taxonomy/families.js';
import { SECTOR_LABELS, SECTOR_ORDER, type Sector } from '../../src/taxonomy/sector.js';
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
 */

const FAMILIES = FAMILY_ORDER.filter((f) => f !== 'unsorted') as Family[];
const PAGE = 50;

interface InstJob {
  key: string;
  title: string;
  company: string;
  provider: string;
  location: string | null;
  remoteType: string | null;
  seniority: string | null;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
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
  maxAgeDays: number;
  jobs: InstJob[];
  error?: string;
}

export default function Institutions() {
  const [sector, setSector] = useState<Sector | ''>('');
  const [family, setFamily] = useState<Family | ''>('');
  const [quietOnly, setQuietOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ limit: String(shown) });
    if (sector) qs.set('sector', sector);
    if (family) qs.set('family', family);
    if (quietOnly) qs.set('quietOnly', '1');
    try {
      const res = await fetch(`/api/institutions?${qs}`);
      const body = (await res.json()) as Payload;
      if (!res.ok) {
        setFailed(body.error ?? 'Could not load institution roles.');
        setData(null);
      } else {
        setFailed(null);
        setData(body);
      }
    } catch {
      setFailed('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [sector, family, quietOnly, shown]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : null;

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
        <a className="navlink" href="/quiet">Quiet roles</a>
        <a className="navlink" href="/">← All roles</a>
      </header>

      <main className="listpage page-inst">
        <div className="quietintro">
          <h2>Institutions</h2>
          <p>
            Universities, hospitals, charities and public bodies. They hire the same
            engineers as everyone else and lose candidates to tech firms on pay and
            flexibility — so their postings sit longer and draw fewer people.
          </p>
        </div>

        <nav className="families quietfams" aria-label="Sector">
          <button className={sector === '' ? 'on' : ''} onClick={() => { setSector(''); setShown(PAGE); }}>
            All
            {total !== null && <span className="n tnum">{total.toLocaleString()}</span>}
          </button>
          {SECTOR_ORDER.map((s) => (
            <button
              key={s}
              className={s === sector ? 'on' : ''}
              onClick={() => { setSector(s); setShown(PAGE); }}
              aria-pressed={s === sector}
            >
              {SECTOR_LABELS[s]}
              {data?.counts?.[s] !== undefined && (
                <span className="n tnum">{data.counts[s]!.toLocaleString()}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="quietnarrow">
          <span className="lbl">Narrow to:</span>
          {FAMILIES.map((f) => (
            <button
              key={f}
              className={family === f ? 'on' : ''}
              onClick={() => { setFamily(family === f ? '' : f); setShown(PAGE); }}
            >
              {FAMILY_LABELS[f]}
            </button>
          ))}
          {/* The two pages compose. An institution role ALSO under a title
              nobody searches for is the least contested thing on the site. */}
          <button
            className={quietOnly ? 'on' : ''}
            onClick={() => { setQuietOnly(!quietOnly); setShown(PAGE); }}
            title="Only roles whose title is not one people search for"
          >
            quiet titles only
          </button>
        </div>

        {failed && <p className="empty">{failed}</p>}

        {data && !failed && (
          <p className="results">
            <span className="count">
              <b className="tnum">{data.matched.toLocaleString()}</b>{' '}
              {sector ? SECTOR_LABELS[sector].toLowerCase() : 'institution'} roles · last{' '}
              {data.maxAgeDays} days
            </span>
          </p>
        )}

        {loading && !data && <p className="empty">Loading…</p>}

        {data && data.jobs.length === 0 && !loading && (
          <p className="empty">
            Nothing here yet. Sector is read from each advert as it is crawled, so this
            fills in over the next few hours rather than all at once.
          </p>
        )}

        <div className="joblist">
          {data?.jobs.map((j) => (
            <JobCard
              key={j.key}
              job={j}
              chips={
                <>
                  {j.sector && <span className="chip sector">{SECTOR_LABELS[j.sector as Sector]}</span>}
                  {j.family && (
                    <span className={`chip fam fam-${j.family}`}>
                      {FAMILY_LABELS[j.family as Family]}
                    </span>
                  )}
                  {j.quiet && <span className="chip quiet">quiet title</span>}
                </>
              }
            />
          ))}
        </div>

        {data?.hasMore && (
          <button className="more" onClick={() => setShown((n) => n + PAGE)} disabled={loading}>
            {loading ? 'Loading…' : `Show ${PAGE} more`}
          </button>
        )}
      </main>
    </>
  );
}
