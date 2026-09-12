'use client';

import { useMemo, useState } from 'react';

import { changeRatio, diffWords } from '../../src/tailor/diff.js';
import { CHIPS } from '../../src/tailor/prompts.js';

/**
 * Tailoring one resume against one posting, with the changes shown.
 *
 * WHAT THIS SCREEN IS FOR
 *
 * Not "here is your new resume". Every product in this space does that, and the
 * result is a document its owner has not read, cannot defend line by line, and
 * which reads as machine-written because it is. This shows a list of individual
 * changes, each one accepted or skipped on its own.
 *
 * THREE VERDICTS, SHOWN DIFFERENTLY ON PURPOSE
 *
 *   verified   every number and technical name traces back to the resume
 *   judgement  it adds something the resume does not say — shown WITH the words
 *              named, and never accepted by a single click the way a verified one
 *              is, because accepting it is a claim the person is making
 *   discarded  structurally unusable, or padding, or a line that is not in the
 *              resume at all
 *
 * The discarded ones are shown, collapsed. They could simply be dropped — nothing
 * is lost — but seeing "this invented 40% and was thrown away" is the only direct
 * evidence a person gets that the checking is real, and that evidence is most of
 * why they would trust the rest of it.
 *
 * WHY EACH EDIT SHOWS A PERCENTAGE
 *
 * The promise is "the least possible change". A number is how somebody checks a
 * promise. It measures content rather than word order, so a reordering reads as
 * near zero — see src/tailor/diff.ts.
 */

interface Edit {
  original: string;
  replacement: string;
  reason: string;
  section?: string;
}

interface CheckedEdit {
  edit: Edit;
  verdict: 'accepted' | 'flagged' | 'rejected';
  note: string;
  unverified: string[];
}

interface TailorResponse {
  edits?: CheckedEdit[];
  gaps?: string[];
  accepted?: number;
  flagged?: number;
  rejected?: number;
  applied?: string[];
  note?: string;
  model?: string;
  via?: string;
  error?: string;
  needsResume?: boolean;
  retryable?: boolean;
  noDescription?: boolean;
  /** True when a person has to fix something — a bad key, no credit. */
  needsAttention?: boolean;
}

export interface TailorPanelProps {
  jobKey: string;
  jobTitle: string;
  company: string;
  /** The full-page editor gives each edit more room; the feed panel is tighter. */
  wide?: boolean;
}

/** One line, with the words that changed marked. */
function Diff({ before, after }: { before: string; after: string }) {
  const spans = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <p className="tdiff">
      {spans.map((s, i) => (
        <span key={i} className={`tw ${s.op}`}>
          {s.text}{' '}
        </span>
      ))}
    </p>
  );
}

export function TailorPanel({ jobKey, jobTitle, company, wide = false }: TailorPanelProps) {
  const [chosen, setChosen] = useState<string[]>(['mirror', 'lead']);
  const [custom, setCustom] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TailorResponse | null>(null);
  /** Edit index to decision. Absent means undecided. */
  const [decided, setDecided] = useState<Record<number, 'taken' | 'skipped'>>({});

  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  async function run() {
    setBusy(true);
    setRes(null);
    setDecided({});
    try {
      const r = await fetch('/api/tailor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobKey, chips: chosen, custom: custom.trim() || null }),
      });
      // Parsed whatever the status. Every error this route returns carries a
      // sentence in `error`, and showing "something went wrong" instead would
      // throw away the only useful part of the response.
      const body = (await r.json().catch(() => ({}))) as TailorResponse;
      setRes(body);
    } catch {
      setRes({ error: 'could not reach the server — check your connection and try again' });
    } finally {
      setBusy(false);
    }
  }

  const edits = res?.edits ?? [];
  const usable = edits
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.verdict !== 'rejected');
  const discarded = edits.map((c, i) => ({ c, i })).filter(({ c }) => c.verdict === 'rejected');

  /** The replacements the person has actually taken, for copying out. */
  const taken = usable.filter(({ i }) => decided[i] === 'taken').map(({ c }) => c.edit.replacement);

  return (
    <div className={`tailor${wide ? ' wide' : ''}`}>
      <div className="thead">
        <strong>Tailor your resume</strong>
        <span className="tsub">
          {jobTitle} · {company}
        </span>
      </div>

      <div className="tchips">
        {CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`tchip${chosen.includes(chip.id) ? ' on' : ''}`}
            onClick={() => toggle(chip.id)}
            title={chip.hint}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Folded away by default. It is the least-used control and the one most
          likely to be left half-written, and an always-open textarea invites
          treating it as required. */}
      {showCustom ? (
        <textarea
          className="tcustom"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Anything else? e.g. keep it to one page, UK spelling"
          maxLength={500}
          rows={2}
        />
      ) : (
        <button type="button" className="tlink" onClick={() => setShowCustom(true)}>
          + add your own instruction
        </button>
      )}

      <div className="tactions">
        <button type="button" className="tgo" onClick={() => void run()} disabled={busy}>
          {busy ? 'Reading the posting…' : 'Suggest changes'}
        </button>
        {!wide && (
          <a className="tlink" href={`/tailor?job=${encodeURIComponent(jobKey)}`}>
            open the full editor →
          </a>
        )}
        {res?.via && (
          <span className="tnote">
            read live from the employer — nothing about this posting is stored
          </span>
        )}
      </div>

      {res?.error && (
        <div className="terror">
          {res.error}
          {res.needsResume && (
            <>
              {' '}
              <a href="/account">Go to your account →</a>
            </>
          )}
        </div>
      )}

      {res && !res.error && (
        <div className="tresult">
          <div className="tsummary">
            {res.accepted ?? 0} verified · {res.flagged ?? 0} need your judgement ·{' '}
            {res.rejected ?? 0} discarded
          </div>

          {usable.length === 0 && (
            <p className="tnone">
              Nothing worth changing for this one. That is a real answer — an
              unchanged line is better than a padded one.
            </p>
          )}

          {usable.map(({ c, i }) => {
            const pct = Math.round(changeRatio(c.edit.original, c.edit.replacement) * 100);
            const decision = decided[i];
            return (
              <div key={i} className={`tedit ${c.verdict}${decision ? ` ${decision}` : ''}`}>
                <div className="tmeta">
                  <span className={`tverdict ${c.verdict}`}>
                    {c.verdict === 'accepted' ? 'verified' : 'your call'}
                  </span>
                  {c.edit.section && <span className="tsection">{c.edit.section}</span>}
                  <span className="tpct">{pct}% of this line changed</span>
                </div>

                <Diff before={c.edit.original} after={c.edit.replacement} />

                <p className="treason">{c.edit.reason}</p>

                {/* The warning sits between the change and the button that takes
                    it, so it cannot be accepted without having been passed. */}
                {c.verdict === 'flagged' && <p className="twarn">⚠ {c.note}</p>}

                <div className="tbuttons">
                  <button
                    type="button"
                    className="ttake"
                    onClick={() => setDecided((d) => ({ ...d, [i]: 'taken' }))}
                    disabled={decision === 'taken'}
                  >
                    {decision === 'taken' ? 'Using this' : c.verdict === 'flagged' ? 'It is true — use it' : 'Use this'}
                  </button>
                  <button
                    type="button"
                    className="tskip"
                    onClick={() => setDecided((d) => ({ ...d, [i]: 'skipped' }))}
                    disabled={decision === 'skipped'}
                  >
                    {decision === 'skipped' ? 'Skipped' : 'Skip'}
                  </button>
                </div>
              </div>
            );
          })}

          {(res.gaps ?? []).length > 0 && (
            <div className="tgaps">
              <strong>What this posting wants that your resume does not show</strong>
              <ul>
                {(res.gaps ?? []).map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
              <p className="tnote">
                Named rather than written around. Only you can close these, and only
                if they are true.
              </p>
            </div>
          )}

          {/* Shown because it is the evidence that the checking is real. A person
              who has watched a fabricated number get thrown away has a reason to
              trust the ones that were not. */}
          {discarded.length > 0 && (
            <details className="tdiscarded">
              <summary>{discarded.length} thrown away before you saw them</summary>
              {discarded.map(({ c, i }) => (
                <div key={i} className="tdrop">
                  <span className="tdroptext">{c.edit.replacement || '(empty)'}</span>
                  <span className="tdropwhy">{c.note}</span>
                </div>
              ))}
            </details>
          )}

          {taken.length > 0 && (
            <div className="ttaken">
              <button
                type="button"
                className="tcopy"
                onClick={() => void navigator.clipboard?.writeText(taken.join('\n'))}
              >
                Copy the {taken.length} line{taken.length === 1 ? '' : 's'} you chose
              </button>
              <span className="tnote">
                Paste them over the originals, then change a phrase in your own
                words — that last step is what keeps a CV sounding like you.
              </span>
            </div>
          )}

          {res.model && (
            <div className="tfoot">
              {res.note} · {res.model}
            </div>
          )}

          {/* Said rather than logged. The only fix is a person replacing a key or
              topping up an account, and nobody will read a server log. */}
          {res.needsAttention && (
            <div className="terror">
              Tailoring is misconfigured — the OpenAI key is missing or was refused.
              This will not fix itself.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
