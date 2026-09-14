'use client';

import { useState } from 'react';

import { CHIPS } from '../../src/tailor/prompts.js';
import { changedLines } from '../../src/ui/resume-render.js';
import { Discarded, EditCard, Gaps, Sheet } from './tailor-parts.js';
import { useTailorSession } from './use-tailor-session.js';

/**
 * Tailoring one resume against one posting, inside a feed card.
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
 * ONE COLUMN, DELIBERATELY, AND THE DOCUMENT LAST
 *
 * It briefly had the edits and the resume side by side, which is right on the full
 * page and wrong here: a feed card is around 700px, so two columns gave the
 * document 300 and a CV at 300px is unreadable. The arrangement is only an
 * improvement when there is room for it. Here the resume follows the changes, and
 * the link to the workspace is offered before either — that is where the document
 * gets the width it needs.
 */

export interface TailorPanelProps {
  jobKey: string;
  jobTitle: string;
  company: string;
  /** Set by the full page. Nothing renders it any more; kept so callers still compile. */
  wide?: boolean;
}

export function TailorPanel({ jobKey, jobTitle, company }: TailorPanelProps) {
  const s = useTailorSession(jobKey, jobTitle);
  const [showCustom, setShowCustom] = useState(false);
  const [view, setView] = useState<'sheet' | 'text'>('sheet');

  const text = s.built?.text ?? '';
  const taken = s.takenEdits.length;

  return (
    <div className="tailor">
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
            className={`tchip${s.chosen.includes(chip.id) ? ' on' : ''}`}
            onClick={() => s.toggleChip(chip.id)}
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
          value={s.custom}
          onChange={(e) => s.setCustom(e.target.value)}
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
        <button type="button" className="tgo" onClick={() => void s.run()} disabled={s.busy}>
          {s.busy ? 'Reading the posting…' : 'Suggest changes'}
        </button>
        <a className="tlink" href={`/tailor?job=${encodeURIComponent(jobKey)}`}>
          open the full editor →
        </a>
        {s.res?.via && (
          <span className="tnote">
            read live from the employer — nothing about this posting is stored
          </span>
        )}
      </div>

      {s.res?.error && (
        <div className="terror">
          {s.res.error}
          {s.res.needsResume && (
            <>
              {' '}
              <a href="/account">Go to your account →</a>
            </>
          )}
        </div>
      )}

      {s.res && !s.res.error && (
        <div className="tresult">
          <div className="tsummary">
            {s.res.accepted ?? 0} verified · {s.res.flagged ?? 0} need your judgement ·{' '}
            {s.res.rejected ?? 0} discarded
          </div>

          {/* The posting, collapsed. Open it to check a claim against what was
              actually asked for; leave it shut to read the diff. */}
          {s.res.jobDescription && (
            <details className="tjd">
              <summary>What the posting asks for</summary>
              <div className="tjdbody">{s.res.jobDescription}</div>
              {s.res.jobDescriptionTruncated && (
                <p className="tnote">Shortened for this panel.</p>
              )}
            </details>
          )}

          {s.usable.length === 0 && (
            <p className="tnone">
              Nothing worth changing for this one. That is a real answer — an
              unchanged line is better than a padded one.
            </p>
          )}

          {s.usable.map(({ c, i }) => (
            <EditCard
              key={i}
              checked={c}
              decision={s.decided[i]}
              onTake={() => s.take(i)}
              onSkip={() => s.skip(i)}
            />
          ))}

          <Gaps gaps={s.res.gaps ?? []} />
          <Discarded items={s.discarded} />

          {s.res.model && (
            <div className="tfoot">
              {s.res.note} · {s.res.model}
            </div>
          )}

          {/* Said rather than logged. The only fix is a person replacing a key or
              topping up an account, and nobody will read a server log. */}
          {s.res.needsAttention && (
            <div className="terror">
              Tailoring is misconfigured — the OpenAI key is missing or was refused.
              This will not fix itself.
            </div>
          )}

          {taken > 0 && s.built && (
            <div className="ttaken">
              <div className="tbuiltmeta">
                {taken} change{taken === 1 ? '' : 's'} applied
                {s.built.refused.length > 0 && ` · ${s.built.refused.length} could not be`}
                <span className="tviews">
                  <button
                    type="button"
                    className={`tview${view === 'sheet' ? ' on' : ''}`}
                    onClick={() => setView('sheet')}
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    className={`tview${view === 'text' ? ' on' : ''}`}
                    onClick={() => setView('text')}
                  >
                    Edit text
                  </button>
                </span>
              </div>

              {view === 'sheet' ? (
                <Sheet
                  text={text}
                  changed={changedLines(text, s.takenEdits.map((e) => e.replacement))}
                  idPrefix="tp"
                />
              ) : (
                <textarea
                  className="tbuilt"
                  value={text}
                  onChange={(e) => s.editText(e.target.value)}
                  rows={18}
                  spellCheck
                />
              )}

              {s.built.refused.length > 0 && (
                <div className="trefused">
                  <strong>These could not be applied</strong>
                  {s.built.refused.map((r, i) => (
                    <div key={i} className="trefuse">
                      <span className="trefusewhat">{r.original}</span>
                      <span className="trefusewhy">{r.why}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="tbuiltactions">
                <button type="button" className="tcopy" onClick={s.copy}>
                  {s.copied ? 'Copied' : 'Copy the whole resume'}
                </button>
                {/* First, and the one most people want: their own document with
                    only the accepted sentences changed. The generated one is the
                    fallback for somebody who pasted text rather than uploading. */}
                <button
                  type="button"
                  className="tcopy"
                  onClick={() => void s.saveOriginalEdited()}
                  disabled={s.saving}
                >
                  {s.saving ? 'Editing your file…' : 'Download my .docx — keeps your layout'}
                </button>
                <button
                  type="button"
                  className="tskip"
                  onClick={() => void s.saveDocx()}
                  disabled={s.saving}
                >
                  Clean .docx instead
                </button>
                <button type="button" className="tskip" onClick={s.printable}>
                  Save as PDF
                </button>
                <a className="tlink" href={`/tailor?job=${encodeURIComponent(jobKey)}`}>
                  open the full editor →
                </a>
              </div>

              <span className="tnote">
                Now change a phrase or two in your own words. That is the single
                thing that keeps a tailored CV from reading like every other one in
                the pile.
              </span>
            </div>
          )}

          {s.buildError && <div className="terror">{s.buildError}</div>}
        </div>
      )}
    </div>
  );
}
