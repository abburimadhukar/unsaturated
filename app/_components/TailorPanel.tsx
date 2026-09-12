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

  /** The assembled resume, once asked for. Null until then. */
  const [built, setBuilt] = useState<{
    text: string;
    applied: number;
    refused: { original: string; why: string }[];
  } | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState('');
  const [copied, setCopied] = useState(false);

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

  /**
   * Asks the server to splice the chosen changes into the stored resume.
   *
   * The browser does not hold the CV — it is deliberately kept off the profile the
   * feed receives — so the document is assembled where the source of truth is and
   * comes back whole.
   */
  async function build(chosenEdits: { original: string; replacement: string }[]) {
    setBuilding(true);
    setBuildError('');
    setCopied(false);
    try {
      const r = await fetch('/api/tailor/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ edits: chosenEdits }),
      });
      const b = (await r.json().catch(() => ({}))) as {
        text?: string;
        applied?: number;
        refused?: { original: string; why: string }[];
        error?: string;
      };
      if (!r.ok || typeof b.text !== 'string') {
        setBuildError(b.error ?? 'could not build your resume — try again');
        return;
      }
      setBuilt({ text: b.text, applied: b.applied ?? 0, refused: b.refused ?? [] });
    } catch {
      setBuildError('could not reach the server — check your connection');
    } finally {
      setBuilding(false);
    }
  }

  const edits = res?.edits ?? [];
  const usable = edits
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.verdict !== 'rejected');
  const discarded = edits.map((c, i) => ({ c, i })).filter(({ c }) => c.verdict === 'rejected');

  /**
   * The edits the person accepted, as pairs.
   *
   * The pair and not just the replacement: the server splices by finding the
   * original, so a list of new lines on its own would be unusable.
   */
  const takenEdits = usable
    .filter(({ i }) => decided[i] === 'taken')
    .map(({ c }) => ({ original: c.edit.original, replacement: c.edit.replacement }));

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
                    onClick={() => { setBuilt(null); setDecided((d) => ({ ...d, [i]: 'taken' })); }}
                    disabled={decision === 'taken'}
                  >
                    {decision === 'taken' ? 'Using this' : c.verdict === 'flagged' ? 'It is true — use it' : 'Use this'}
                  </button>
                  <button
                    type="button"
                    className="tskip"
                    onClick={() => { setBuilt(null); setDecided((d) => ({ ...d, [i]: 'skipped' })); }}
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

          {takenEdits.length > 0 && (
            <div className="ttaken">
              {!built ? (
                <>
                  <button
                    type="button"
                    className="tcopy"
                    onClick={() => void build(takenEdits)}
                    disabled={building}
                  >
                    {building
                      ? 'Building…'
                      : `Build my resume with ${takenEdits.length} change${takenEdits.length === 1 ? '' : 's'}`}
                  </button>
                  <span className="tnote">
                    Your whole resume, with these changes spliced in. Every one is
                    checked again on the way.
                  </span>
                </>
              ) : (
                <>
                  <div className="tbuiltmeta">
                    {built.applied} change{built.applied === 1 ? '' : 's'} applied
                    {built.refused.length > 0 && ` · ${built.refused.length} could not be`}
                  </div>

                  {/* Editable on purpose. The most effective thing a person can do
                      to a tailored CV is rewrite one phrase per bullet in their own
                      voice, and a read-only box would send them elsewhere to do it. */}
                  <textarea
                    className="tbuilt"
                    value={built.text}
                    onChange={(e) => setBuilt({ ...built, text: e.target.value })}
                    rows={18}
                    spellCheck
                  />

                  {built.refused.length > 0 && (
                    <div className="trefused">
                      <strong>These could not be applied</strong>
                      {built.refused.map((r, i) => (
                        <div key={i} className="trefuse">
                          <span className="trefusewhat">{r.original}</span>
                          <span className="trefusewhy">{r.why}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="tbuiltactions">
                    <button
                      type="button"
                      className="tcopy"
                      onClick={() => {
                        void navigator.clipboard?.writeText(built.text);
                        setCopied(true);
                      }}
                    >
                      {copied ? 'Copied' : 'Copy the whole resume'}
                    </button>
                    <button
                      type="button"
                      className="tskip"
                      onClick={() => {
                        // A plain-text file built in the page. Nothing is stored and
                        // nothing is uploaded to produce it.
                        const blob = new Blob([built.text], { type: 'text/plain;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `resume-${jobTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.txt`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download as .txt
                    </button>
                    <button type="button" className="tlink" onClick={() => setBuilt(null)}>
                      start again
                    </button>
                  </div>

                  <span className="tnote">
                    Now change a phrase or two in your own words. That is the single
                    thing that keeps a tailored CV from reading like every other one
                    in the pile.
                  </span>
                </>
              )}
              {buildError && <div className="terror">{buildError}</div>}
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
