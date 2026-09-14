'use client';

import Link from 'next/link';
import { useState } from 'react';

import { CHIPS } from '../../src/tailor/prompts.js';
import { changedLines } from '../../src/ui/resume-render.js';
import { Discarded, EditCard, Gaps, Sheet, lineOf } from './tailor-parts.js';
import { useTailorSession } from './use-tailor-session.js';

/**
 * The full-screen tailoring workspace.
 *
 * WHY IT TAKES THE WHOLE SCREEN
 *
 * The page it replaced was capped at 860px and split into two columns, which gave
 * the document about 350px of measure — a resume wrapping at 49 characters where
 * the file it becomes wraps at about 95. That is not a cramped version of the
 * right thing; it makes the preview answer the wrong question. "Would I send
 * this?" cannot be judged from a document laid out at half its real width, because
 * every bullet wraps twice as often as it will on paper.
 *
 * So the measure comes first and the page is sized around it: the sheet gets a
 * fixed width, and the changes column takes what is left. When there is not room
 * for both, the changes column goes and the panes become tabs — the resume is
 * never shown at the wrong width, because a wrong-width resume is worse than no
 * resume.
 *
 * WHAT WAS TAKEN FROM THE TOOLS THAT DO THIS ALREADY
 *
 * From Jobscan, the one genuinely good idea: the changes list is NAVIGATION. Click
 * a change and the document scrolls to that line and pulses. Their own help text
 * describes it as "click on a missing skill in the left panel, and it will direct
 * you to the resume section" — a list that moves the document beats two lists a
 * person has to join up in their head.
 *
 * From Huntr, a warning rather than an idea. Reviewers describe being dropped into
 * "resume preview, scoring, feedback panels, resume sections, AI tailoring tools,
 * design settings, and various optimizations" at once, and call it overwhelming.
 * Using the whole screen is not the same as filling it. So there are two panes and
 * the posting is a drawer, not a third column.
 *
 * THE DOCUMENT IS THERE BEFORE ANYTHING IS SUGGESTED
 *
 * Which is the other half of why the old screen was confusing: it opened on
 * controls with nothing to apply them to, and the resume only existed after
 * clicking through two separate steps. Here the CV is loaded on arrival, changes
 * land into a document that is already on screen, and un-accepting one visibly
 * puts the line back.
 */

export interface TailorWorkspaceProps {
  jobKey: string;
  jobTitle: string;
  company: string;
  applyUrl: string | null;
  closed: boolean;
}

/** How long the jumped-to line stays marked. Long enough to find, short enough not to nag. */
const FLASH_MS = 1200;

export function TailorWorkspace({
  jobKey,
  jobTitle,
  company,
  applyUrl,
  closed,
}: TailorWorkspaceProps) {
  const s = useTailorSession(jobKey, jobTitle);

  const [showCustom, setShowCustom] = useState(false);
  const [view, setView] = useState<'sheet' | 'text'>('sheet');
  const [posting, setPosting] = useState(false);
  /** Which pane is showing when the window is too narrow for both. */
  const [pane, setPane] = useState<'changes' | 'resume'>('changes');
  const [flash, setFlash] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const text = s.built?.text ?? '';
  const changed = changedLines(text, s.takenEdits.map((e) => e.replacement));

  /**
   * Point the document at one change.
   *
   * Only a taken change has a line to point at — an unaccepted one is not in the
   * document yet — so for the rest this selects the card and leaves the resume
   * where it is rather than scrolling somewhere arbitrary.
   */
  function jump(i: number, replacement: string) {
    setSelected(i);
    const line = lineOf(text, replacement);
    if (line === null) return;
    setPane('resume');
    setFlash(line);
    // Deferred one frame: on a narrow screen the resume pane has only just been
    // switched on, and an element that is still display:none cannot be scrolled to.
    requestAnimationFrame(() => {
      document.getElementById(`tw-${line}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    setTimeout(() => setFlash((f) => (f === line ? null : f)), FLASH_MS);
  }

  const suggested = s.usable.length;
  const taken = s.takenEdits.length;

  return (
    <div className={`twork pane-${pane}`}>
      {/* ------------------------------------------------------------------ */}
      <header className="twtop">
        <Link className="twback" href="/">
          ← Feed
        </Link>
        <div className="twwhat">
          <h1>{jobTitle}</h1>
          <p>
            {company}
            {/* Said plainly. Tailoring a CV for a role that has been withdrawn is
                wasted effort, and the feed cannot always know before the fetch does. */}
            {closed && <span className="tclosed"> · this posting has closed</span>}
          </p>
        </div>

        <div className="twtools">
          {/* Tabs, and only when there is not room for both panes. The alternative
              was stacking them, which means scrolling past every change to reach
              the CV. */}
          <div className="twtabs" role="tablist" aria-label="Panel">
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'changes'}
              className={pane === 'changes' ? 'on' : ''}
              onClick={() => setPane('changes')}
            >
              Changes{suggested > 0 ? ` · ${suggested}` : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'resume'}
              className={pane === 'resume' ? 'on' : ''}
              onClick={() => setPane('resume')}
            >
              Resume
            </button>
          </div>

          {s.res?.jobDescription && (
            <button type="button" className="twghost" onClick={() => setPosting(true)}>
              What the posting asks for
            </button>
          )}
          {applyUrl && (
            <a className="twghost" href={applyUrl} target="_blank" rel="noopener noreferrer">
              Open the posting ↗
            </a>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      <div className="twbody">
        <section className="twleft" aria-label="Suggested changes">
          <div className="twcontrols">
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

            {/* Folded away by default. It is the least-used control and the one
                most likely to be left half-written, and an always-open textarea
                invites treating it as required. */}
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
              <button
                type="button"
                className="tgo"
                onClick={() => void s.run()}
                disabled={s.busy}
              >
                {s.busy
                  ? 'Reading the posting…'
                  : s.res
                    ? 'Suggest again'
                    : 'Suggest changes'}
              </button>
              {s.res?.via && (
                <span className="tnote">
                  read live from the employer — nothing about this posting is stored
                </span>
              )}
            </div>
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
            <>
              <div className="tsummary">
                {s.res.accepted ?? 0} verified · {s.res.flagged ?? 0} need your judgement ·{' '}
                {s.res.rejected ?? 0} discarded
              </div>

              {suggested === 0 && (
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
                  selected={selected === i}
                  onSelect={() => jump(i, c.edit.replacement)}
                  onTake={() => {
                    s.take(i);
                    setSelected(i);
                  }}
                  onSkip={() => {
                    s.skip(i);
                    if (selected === i) setSelected(null);
                  }}
                />
              ))}

              <Gaps gaps={s.res.gaps ?? []} />
              <Discarded items={s.discarded} />

              {s.res.model && (
                <div className="tfoot">
                  {s.res.note} · {s.res.model}
                </div>
              )}

              {/* Said rather than logged. The only fix is a person replacing a key
                  or topping up an account, and nobody will read a server log. */}
              {s.res.needsAttention && (
                <div className="terror">
                  Tailoring is misconfigured — the OpenAI key is missing or was
                  refused. This will not fix itself.
                </div>
              )}
            </>
          )}

          {!s.res && !s.busy && (
            <p className="twhint">
              Pick what you want changed, then suggest. Every change is shown on its
              own and goes into the document on the right only when you say so.
            </p>
          )}
        </section>

        {/* ---------------------------------------------------------------- */}
        <section className="twright" aria-label="Your resume">
          {s.noResume ? (
            <p className="twempty">
              There is no resume on your account yet.{' '}
              <a href="/account">Add one →</a>
            </p>
          ) : s.loadingResume ? (
            <p className="twempty">Loading your resume…</p>
          ) : !s.built ? (
            /* Signed out, or the load failed. Without this branch the pane renders
               an EMPTY sheet — a blank sheet of paper where somebody's CV should
               be, which reads as "we lost your resume" rather than "sign in". */
            <p className="twempty">
              {s.buildError || 'Your resume could not be loaded.'}{' '}
              <a href="/signin">Sign in →</a>
            </p>
          ) : (
            <>
              <div className="twsheetbar">
                <span className="twtally">
                  {taken === 0
                    ? 'Your resume, unchanged'
                    : `${taken} change${taken === 1 ? '' : 's'} in`}
                  {s.building && <span className="twbusy"> · updating…</span>}
                </span>
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

              <div className="twsheet">
                {view === 'sheet' ? (
                  <Sheet text={text} changed={changed} idPrefix="tw" flash={flash} />
                ) : (
                  /* Editable on purpose. The most effective thing a person can do
                     to a tailored CV is rewrite one phrase per bullet in their own
                     voice, and a read-only view would send them elsewhere to do it. */
                  <textarea
                    className="tbuilt"
                    value={text}
                    onChange={(e) => s.editText(e.target.value)}
                    spellCheck
                  />
                )}

                {s.built && s.built.refused.length > 0 && (
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

                <p className="twcaption">
                  {taken > 0
                    ? 'The highlighted lines are the ones you accepted. This is a reading of your words — if you download your own .docx it keeps your real layout, and only those lines change.'
                    : 'Your resume as it stands. Accept a change on the left and it appears here.'}
                </p>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ------------------------------------------------------------------ */}
      <footer className="twbot">
        <span className="twcount">
          <b>{taken}</b> of {suggested || 0} change{suggested === 1 ? '' : 's'} in your resume
          {s.undecided > 0 && <span className="twdim"> · {s.undecided} still to decide</span>}
        </span>

        {s.buildError && <span className="twerr">{s.buildError}</span>}

        <button type="button" className="twghost" onClick={s.copy} disabled={!s.built}>
          {s.copied ? 'Copied' : 'Copy text'}
        </button>
        <button type="button" className="twghost" onClick={s.printable} disabled={!s.built}>
          Save as PDF
        </button>
        <button
          type="button"
          className="twghost"
          onClick={() => void s.saveDocx()}
          disabled={!s.built || s.saving}
        >
          Clean .docx
        </button>
        {/* First, and the one most people want: their own document with only the
            accepted sentences changed. The generated one is the fallback for
            somebody who pasted text rather than uploading a file. */}
        <button
          type="button"
          className="twprimary"
          onClick={() => void s.saveOriginalEdited()}
          disabled={!s.built || s.saving || taken === 0}
          title={taken === 0 ? 'Accept a change first' : 'Keeps your own layout'}
        >
          {s.saving ? 'Editing your file…' : 'Download my .docx'}
        </button>
      </footer>

      {/* ------------------------------------------------------------------ */}
      {/* The posting, behind a button rather than beside the resume. It is an
          input to the work and not part of it: every change quotes its own reason,
          so the advert is what you open to check one, not something to keep on
          screen. A permanent third column is what tips a workspace into the mess
          Huntr's reviewers describe. */}
      {posting && s.res?.jobDescription && (
        <>
          <div className="twscrim" onClick={() => setPosting(false)} />
          <aside className="twdrawer" aria-label="The posting">
            <div className="twdrawerhead">
              <div>
                <h2>{jobTitle}</h2>
                <p className="tnote">
                  {company} · read live from the employer · nothing about this
                  posting is stored
                </p>
              </div>
              <button type="button" className="twghost" onClick={() => setPosting(false)}>
                Close
              </button>
            </div>
            <div className="twdrawerbody">{s.res.jobDescription}</div>
            {s.res.jobDescriptionTruncated && (
              <p className="tnote">Shortened — open the posting for the rest.</p>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
