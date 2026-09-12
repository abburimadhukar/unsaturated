'use client';

import { useMemo, useState } from 'react';

import { changeRatio, diffWords } from '../../src/tailor/diff.js';
import { CHIPS } from '../../src/tailor/prompts.js';
import { docxBlob, docxFileName } from '../../src/ui/docx.js';

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

  const [saving, setSaving] = useState(false);

  /**
   * The .docx, built in the page.
   *
   * Nothing is uploaded and nothing is stored to produce it: the text is already
   * here, and the browser's own deflater does the compression — see
   * src/ui/docx.ts, which is the mirror of the unzipper the upload path uses.
   */
  async function saveDocx(text: string) {
    setSaving(true);
    try {
      const blob = await docxBlob(text);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = docxFileName(jobTitle);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setBuildError('could not build the .docx — copy the text instead');
    } finally {
      setSaving(false);
    }
  }

  /**
   * The person's own file, edited.
   *
   * Preferred over the generated document whenever they uploaded a .docx, because
   * it keeps their layout. The server does the editing — the original lives in a
   * private bucket and the browser has no copy.
   */
  async function saveOriginalEdited(chosen: { original: string; replacement: string }[]) {
    setSaving(true);
    setBuildError('');
    try {
      const r = await fetch('/api/tailor/docx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ edits: chosen }),
      });
      if (!r.ok) {
        // Every refusal from this route carries a sentence that says what to do —
        // upload a file, upload the .docx rather than the PDF, re-save it.
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        setBuildError(b.error ?? 'could not edit your file');
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // The filename the server chose, which is the person's own name for it.
      const disp = r.headers.get('content-disposition') ?? '';
      a.download = /filename="([^"]+)"/.exec(disp)?.[1] ?? docxFileName(jobTitle);
      a.click();
      URL.revokeObjectURL(url);

      const missed = Number(r.headers.get('x-edits-missed') ?? '0');
      if (missed > 0) {
        setBuildError(
          `${missed} change${missed === 1 ? '' : 's'} could not be found in your file, so ${missed === 1 ? 'it was' : 'they were'} left out. The rest are in the download.`,
        );
      }
    } catch {
      setBuildError('could not reach the server — check your connection');
    } finally {
      setSaving(false);
    }
  }

  /**
   * PDF, via the browser's own print dialogue.
   *
   * NOT a hand-rolled PDF, deliberately. Constructing one means laying out the
   * text layer by hand, and getting the spacing wrong produces a file that looks
   * right and extracts as "Ranmulti-regionAWS" — which is the failure that
   * matters, because the first reader of a resume is usually a parser. The browser
   * handles fonts, kerning and the text layer properly and for free.
   *
   * A separate window rather than a print stylesheet over this page: the feed is a
   * long document with a sticky header, and hiding all of it reliably takes more
   * CSS than it takes to render the one thing being printed on its own.
   */
  function printable(text: string) {
    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) {
      setBuildError('your browser blocked the print window — allow pop-ups, or download the .docx');
      return;
    }
    // Escaped rather than inserted. It is the person's own CV, but it is still
    // text going into markup, and "<" in "C++ <algorithm>" would eat the rest.
    const safe = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8">' +
        `<title>${docxFileName(jobTitle).replace(/\.docx$/, '')}</title>` +
        '<style>@page{size:A4;margin:18mm}' +
        'body{font:11pt/1.5 Calibri,Carlito,system-ui,sans-serif;color:#000;margin:0}' +
        'pre{font:inherit;white-space:pre-wrap;margin:0}</style>' +
        `</head><body><pre>${safe}</pre></body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
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
                    {/* First, and the one most people want: their own document with
                        only the accepted sentences changed. The generated one is
                        the fallback for somebody who pasted text rather than
                        uploading a file. */}
                    <button
                      type="button"
                      className="tcopy"
                      onClick={() => void saveOriginalEdited(takenEdits)}
                      disabled={saving}
                    >
                      {saving ? 'Editing your file…' : 'Download my .docx — keeps your layout'}
                    </button>
                    <button
                      type="button"
                      className="tskip"
                      onClick={() => void saveDocx(built.text)}
                      disabled={saving}
                    >
                      Clean .docx instead
                    </button>
                    <button type="button" className="tskip" onClick={() => printable(built.text)}>
                      Save as PDF
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
