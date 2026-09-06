'use client';

import { useCallback, useEffect, useState } from 'react';
import { FAMILY_LABELS, FAMILY_ORDER, type Family } from '../../src/taxonomy/families.js';
import { SPECIALIZATION_LABELS } from '../../src/taxonomy/specializations.js';
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
 */

const FAMILIES = FAMILY_ORDER.filter((f) => f !== 'unsorted') as Family[];

interface QuietJob {
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
  counts: Record<string, number>;
  maxAgeDays: number;
  jobs: QuietJob[];
  error?: string;
}

const PAGE = 50;

export default function QuietRoles() {
  const [family, setFamily] = useState<Family>('cloud');
  const [onSite, setOnSite] = useState(false);
  const [noEntry, setNoEntry] = useState(false);
  const [midMarket, setMidMarket] = useState(false);
  const [shown, setShown] = useState(PAGE);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ family, limit: String(shown) });
    if (onSite) qs.set('onSite', '1');
    if (noEntry) qs.set('noEntry', '1');
    if (midMarket) qs.set('midMarket', '1');
    try {
      const res = await fetch(`/api/quiet?${qs}`);
      const body = (await res.json()) as Payload;
      if (!res.ok) {
        setFailed(body.error ?? 'Could not load quiet roles.');
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
  }, [family, onSite, noEntry, midMarket, shown]);

  useEffect(() => {
    void load();
  }, [load]);

  // Changing what you are looking at should start you at the top of it.
  const pick = (f: Family) => {
    setFamily(f);
    setShown(PAGE);
  };
  const toggle = (set: (v: boolean) => void, v: boolean) => {
    set(v);
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
        <a className="navlink" href="/">← All roles</a>
      </header>

      <main className="listpage page-quiet">
        <div className="quietintro">
          <h2>Quiet roles</h2>
          <p>
            The same work, advertised under a title people do not search for. A
            “Cloud Operations Analyst” and a “Cloud Engineer” can be the same job —
            but only one of them is what everybody types into the box.
          </p>
        </div>

        <nav className="families quietfams" aria-label="Role family">
          {FAMILIES.map((f) => (
            <button
              key={f}
              className={f === family ? `fam-${f} on` : `fam-${f}`}
              onClick={() => pick(f)}
              aria-pressed={f === family}
            >
              {FAMILY_LABELS[f]}
              {data?.counts?.[f] !== undefined && (
                <span className="n tnum">{data.counts[f]!.toLocaleString()}</span>
              )}
            </button>
          ))}
        </nav>

        {/* Each of these is a real, measurable reason fewer people see a role —
            not a preference. They are off by default so the page opens with the
            widest honest answer. */}
        <div className="quietnarrow">
          <span className="lbl">Quieter still:</span>
          <button className={onSite ? 'on' : ''} onClick={() => toggle(setOnSite, !onSite)}>
            not fully remote
          </button>
          <button className={noEntry ? 'on' : ''} onClick={() => toggle(setNoEntry, !noEntry)}>
            not entry level
          </button>
          <button className={midMarket ? 'on' : ''} onClick={() => toggle(setMidMarket, !midMarket)}>
            rarely-syndicated board
          </button>
        </div>

        {failed && (
          <p className="empty">
            {failed}
          </p>
        )}

        {data && !failed && (
          <p className="results">
            <span className="count">
              <b className="tnum">{data.matched.toLocaleString()}</b> quiet{' '}
              {FAMILY_LABELS[family].toLowerCase()} roles · last {data.maxAgeDays} days
            </span>
          </p>
        )}

        {loading && !data && <p className="empty">Loading…</p>}

        {data && data.jobs.length === 0 && !loading && (
          <p className="empty">Nothing quiet here right now. Try turning a narrowing off.</p>
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
                  <span className={`chip fam fam-${family}`}>{FAMILY_LABELS[family]}</span>
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
          <button className="more" onClick={() => setShown((n) => n + PAGE)} disabled={loading}>
            {loading ? 'Loading…' : `Show ${PAGE} more`}
          </button>
        )}
      </main>
    </>
  );
}
