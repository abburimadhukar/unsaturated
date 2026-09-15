'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { Concern } from '../../src/tailor/rewrite.js';
import { Changes, CompareView } from './Changes.js';
import { Coverage } from './Coverage.js';
import { RoleSuggestions, SkillSuggestions } from './Suggestions.js';
import { Sheet } from './tailor-parts.js';
import { useRewrite } from './use-rewrite.js';

/**
 * Tailoring, as a finished document rather than as homework.
 *
 * WHAT THIS REPLACED AND WHY
 *
 * The previous screen listed suggested line edits and asked the person to accept
 * each one. Run against a real posting with a real model, it produced seven
 * suggestions — the most substantial of which moved "React.js" two words earlier.
 * Eleven rows reading "NOT FOUND", two of which were not even skills. Nobody can
 * do anything with that.
 *
 * So the model writes the resume. The screen shows the resume. The only thing
 * asked of the person is the small amount of judgement software genuinely cannot
 * supply.
 *
 * THE WHOLE DOCUMENT ARRIVES. NOTHING IS HELD BACK.
 *
 * An earlier version of this screen kept unverified lines out of the document
 * until they were confirmed, and threw away the ones it could not trace at all.
 * Both were the code editing somebody's CV on evidence that could not support the
 * decision — a resume is a summary of a career, not a record of it, and "I cannot
 * find this" is a fact about the document, not about the person.
 *
 * Now everything the model wrote is in the resume on the right, flagged lines
 * marked in place, and taking one out is one click. Louder, not quieter: what used
 * to vanish is now something you have to look at.
 *
 * THE THINGS ON SCREEN, IN ORDER
 *
 *   1. Lines to check, if any, each with the reason in plain words and a button
 *      to take it out. Usually none or a handful.
 *   2. What the posting asks for, and the honest answer to each.
 *   3. Every line that changed, with the original beside it.
 *   4. The document, full width, at the measure it will be read at.
 *   5. What the MODEL chose to leave out, collapsed — its decision, not ours.
 */

export interface RewriteWorkspaceProps {
  jobKey: string;
  jobTitle: string;
  company: string;
  applyUrl: string | null;
  closed: boolean;
}

/**
 * The flag, in two or three words, so a list of them can be skimmed.
 *
 * Ordered by how much they should worry somebody. "Not in your resume" is a claim
 * that may be untrue; "wrong job" is almost certainly true of them but possibly
 * not there; "reads generated" is a matter of taste and is marked as the mildest
 * thing on the page rather than, as it once was, grounds for deletion.
 */
const CONCERN: Record<Concern, string> = {
  none: '',
  'no-employer': 'employer not in your resume',
  'not-in-resume': 'not in your resume',
  'other-employer': 'a different job',
  voice: 'reads generated',
};

export function RewriteWorkspace({
  jobKey,
  jobTitle,
  company,
  applyUrl,
  closed,
}: RewriteWorkspaceProps) {
  const s = useRewrite(jobKey, jobTitle);
  const [showAsk, setShowAsk] = useState(false);
  const [posting, setPosting] = useState(false);
  const [pane, setPane] = useState<'setup' | 'resume'>('setup');
  /** Which way the document is shown. Tailored first, deliberately. */
  const [view, setView] = useState<'tailored' | 'compare' | 'edit'>('tailored');

  const rewrite = s.res?.rewrite ?? null;
  const dropped = rewrite?.dropped ?? [];
  /** Flagged and still in the document — the number that actually needs a look. */
  const toCheck = s.flagged.filter((l) => !s.removed.has(l.text));
  /** Suggestions ticked, counted off the answer rather than off the tick set, so
      a stale tick from a previous run cannot inflate it. */
  const pickedCount =
    (s.sug.skills?.skills?.skills ?? []).filter((x) => s.picked.has(x.skill)).length +
    (s.sug.roles?.roles?.companies ?? [])
      .flatMap((c) => c.bullets)
      .filter((b) => s.picked.has(b.text)).length;

  return (
    <div className={`twork pane-${pane === 'setup' ? 'changes' : 'resume'}`}>
      <header className="twtop">
        <Link className="twback" href="/">
          ← Feed
        </Link>
        <div className="twwhat">
          <h1>{jobTitle}</h1>
          <p>
            {company}
            {closed && <span className="tclosed"> · this posting has closed</span>}
          </p>
        </div>

        <div className="twtools">
          <div className="twtabs" role="tablist" aria-label="Panel">
            <button
              type="button"
              role="tab"
              aria-selected={pane === 'setup'}
              className={pane === 'setup' ? 'on' : ''}
              onClick={() => setPane('setup')}
            >
              Options{toCheck.length > 0 ? ` · ${toCheck.length}` : ''}
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

      <div className="twbody">
        {/* ---------------------------------------------------------------- */}
        <section className="twleft" aria-label="Options">
          <div className="twcontrols">
            <p className="rwlead">
              {rewrite
                ? 'Rewritten for this job. Every line traces back to something you already wrote.'
                : 'This rewrites your whole resume for this job — summary, skills order and the bullets under each employer. Nothing is invented.'}
            </p>

            {/* The six preset chips — "Fit one page", "Show the depth", "Lead
                with their industry" and the rest — were removed at the owner's
                instruction, along with the `presets` field behind them. They were
                a menu of ways to phrase one request. The two buttons below ask a
                different question and hand back things to tick, which is what
                the chips were reaching for. The free-text box stays: that is
                somebody saying something specific in their own words. */}
            {showAsk ? (
              <textarea
                className="tcustom"
                value={s.ask}
                onChange={(e) => s.setAsk(e.target.value)}
                placeholder="Anything else? e.g. UK spelling, drop the 2018 job"
                maxLength={500}
                rows={2}
              />
            ) : (
              <button type="button" className="tlink" onClick={() => setShowAsk(true)}>
                + tell it something else
              </button>
            )}

            <div className="tactions">
              <button
                type="button"
                className="tgo"
                onClick={() => {
                  setPane('resume');
                  void s.run();
                }}
                disabled={s.busy}
              >
                {s.busy
                  ? 'Writing your resume…'
                  : rewrite
                    ? 'Write it again'
                    : 'Write my resume for this job'}
              </button>
              {s.res?.via && (
                <span className="tnote">
                  read live from the employer — nothing about this posting is stored
                </span>
              )}
            </div>

            {/* Two different questions, and neither needs the rewrite above.
                They work on the CV on file, so somebody can ask what they are
                missing without paying for a document they may not want. */}
            <div className="sugbuttons">
              <button
                type="button"
                className="sugbtn"
                onClick={() => void s.askFor('skills')}
                disabled={s.asking !== null}
              >
                {s.asking === 'skills' ? 'Reading the posting…' : 'Skills validation'}
              </button>
              <button
                type="button"
                className="sugbtn"
                onClick={() => void s.askFor('roles')}
                disabled={s.asking !== null}
              >
                {s.asking === 'roles' ? 'Writing points…' : 'Roles validation'}
              </button>
            </div>
            <p className="tnote">
              Skills: what this posting wants that your resume does not show, and where it
              would go. Roles: two responsibilities per employer covering those gaps.
            </p>
          </div>

          {s.error && (
            <div className="terror">
              {s.error}
              {s.res?.needsResume && (
                <>
                  {' '}
                  <a href="/account">Go to your account →</a>
                </>
              )}
            </div>
          )}

          {/* ---- what the model suggested, ticked one at a time ----

              Both panels render together and neither clears the other. They are
              two halves of one answer: the skills you are missing, and the
              responsibilities that would cover them. Ticks from both go into the
              same document at the same time.

              The caution is said ONCE, above both, rather than per panel or per
              row — somebody told six times stops reading the seventh. */}
          {(s.sug.skills?.error || s.sug.roles?.error) && (
            <div className="terror">{s.sug.skills?.error ?? s.sug.roles?.error}</div>
          )}

          {(s.sug.skills?.skills || s.sug.roles?.roles) && (
            <section className="sug">
              <div className="sughead">
                <h2>Suggestions</h2>
                {pickedCount > 0 && (
                  <span className="sugcount">{pickedCount} added to your resume</span>
                )}
              </div>
              <p className="tnote">
                Nothing here was checked against your resume — it cannot be, because all of it
                is by definition what your resume does not say. These describe work you may
                have done and not written down. <strong>Tick only what is true of you.</strong>
              </p>

              {s.sug.skills?.skills && (
                <>
                  <h3 className="sugpart">Skills you are missing</h3>
                  <SkillSuggestions
                    answer={s.sug.skills.skills}
                    picked={s.picked}
                    onPick={s.pick}
                  />
                </>
              )}

              {s.sug.roles?.roles && (
                <>
                  <h3 className="sugpart">Responsibilities that would cover them</h3>
                  <RoleSuggestions answer={s.sug.roles.roles} picked={s.picked} onPick={s.pick} />
                </>
              )}

              <p className="tfoot">
                {[s.sug.skills?.note, s.sug.roles?.note].filter(Boolean).join(' · ')}
              </p>
            </section>
          )}

          {/* ---- the only work there is ---- */}
          {s.flagged.length > 0 && (
            <section className="rwask">
              <h2>
                {s.flagged.length} line{s.flagged.length === 1 ? '' : 's'} to check
              </h2>
              <p className="tnote">
                Nothing was removed. These are in your resume — the checker could not trace
                them to what you wrote, and it says why for each. Take out anything that is not
                true of you.
              </p>
              {s.flagged.map((l, i) => {
                const out = s.removed.has(l.text);
                return (
                  <div className={`rwq${out ? ' gone' : ''}`} key={i}>
                    <p className="rwqtext">{l.text}</p>
                    <p className="rwqtag">{CONCERN[l.concern]}</p>
                    <p className="rwqwhy">{l.question ?? l.note}</p>
                    <div className="tbuttons">
                      {out ? (
                        <button type="button" className="ttake" onClick={() => s.keep(l.text)}>
                          Put it back
                        </button>
                      ) : (
                        <button type="button" className="tskip" onClick={() => s.remove(l.text)}>
                          Take it out
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {/* What they asked for, and the honest answer for each. Above the
              changes, because "should I apply at all" is the larger question. */}
          {rewrite && <Coverage requirements={rewrite.requirements} tally={rewrite.tally} />}

          {rewrite && (
            <Changes
              rewrite={rewrite}
              reverted={s.reverted}
              onRevert={s.revert}
              onRestore={s.restore}
            />
          )}

          {s.removed.size > 0 && (
            <p className="rwconfirmed">
              {s.removed.size} line{s.removed.size === 1 ? '' : 's'} taken out by you.
            </p>
          )}

          {rewrite && rewrite.voice.length > 0 && (
            <div className="rwvoice">
              <strong>Worth a look</strong>
              {rewrite.voice.map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </div>
          )}

          {/* ---- what it cut, available rather than insisted upon ---- */}
          {dropped.length > 0 && (
            <details className="tdiscarded">
              {/* The model's own decisions, not the checker's — the checker no
                  longer leaves anything out. */}
              <summary>{dropped.length} lines it chose not to carry over</summary>
              {dropped.map((d, i) => (
                <div key={i} className="tdrop">
                  <span className="tdroptext">{d.text}</span>
                  <span className="tdropwhy">{d.why}</span>
                </div>
              ))}
            </details>
          )}

          {rewrite && (
            <div className="tfoot">
              {s.res?.note} · {s.res?.model}
            </div>
          )}

          {(s.res?.resumeCutBy ?? 0) > 0 && (
            <div className="terror">
              Your resume is long enough that the last {s.res!.resumeCutBy!.toLocaleString()}{' '}
              characters of it were not sent, so anything at the very end is missing from this
              rewrite. Shorten it on your account page and run this again.
            </div>
          )}

          {s.res?.needsAttention && (
            <div className="terror">
              Tailoring is misconfigured — the OpenAI key is missing or was refused.
            </div>
          )}
        </section>

        {/* ---------------------------------------------------------------- */}
        <section className="twright" aria-label="Your resume">
          {s.busy ? (
            <p className="twempty">
              Reading the posting and writing your resume. About twenty seconds.
            </p>
          ) : s.asking ? (
            <p className="twempty">
              Reading the posting against your resume.
              <br />
              {s.asking === 'skills' ? 'Finding what is missing.' : 'Writing the points.'}
            </p>
          ) : !s.document ? (
            <p className="twempty">
              Your tailored resume appears here.
              <br />
              Pick what you want on the left, then write it.
            </p>
          ) : (
            <>
              <div className="twsheetbar">
                <span className="twtally">
                  {/* Honest about which document this is. Without a rewrite it is
                      their own CV with whatever they ticked added, and calling
                      that "tailored" would overstate what happened to it. */}
                  {rewrite ? `Tailored for ${company}` : 'Your resume'}
                  {pickedCount > 0 && (
                    <span className="twflag">
                      {' '}
                      · {pickedCount} suggestion{pickedCount === 1 ? '' : 's'} added
                    </span>
                  )}
                  {toCheck.length > 0 && (
                    <span className="twflag">
                      {' '}
                      · {toCheck.length} marked line{toCheck.length === 1 ? '' : 's'} to check
                    </span>
                  )}
                  {s.removed.size > 0 && (
                    <span className="twdim"> · {s.removed.size} taken out by you</span>
                  )}
                  {s.reverted.size > 0 && (
                    <span className="twdim"> · {s.reverted.size} of your originals kept</span>
                  )}
                  {s.edited !== null && <span className="twedited"> · edited by you</span>}
                </span>
                <span className="tviews">
                  {(['tailored', 'compare', 'edit'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={`tview${view === v ? ' on' : ''}`}
                      onClick={() => setView(v)}
                    >
                      {v === 'tailored' ? 'Tailored' : v === 'compare' ? 'Compare' : 'Edit'}
                    </button>
                  ))}
                </span>
              </div>

              {view === 'compare' ? (
                <CompareView before={s.original} after={s.document} />
              ) : view === 'edit' ? (
                <div className="twsheet">
                  {/* Editable, because the most effective thing anybody can do to a
                      tailored CV is rewrite one phrase in their own voice — and a
                      read-only view sends them elsewhere to do it. What is typed
                      here survives reverting an unrelated line. */}
                  <textarea
                    className="tbuilt"
                    value={s.document}
                    onChange={(e) => s.setEdited(e.target.value)}
                    spellCheck
                  />
                  {s.edited !== null && (
                    <p className="twcaption">
                      You have edited this by hand.{' '}
                      <button type="button" className="tlink" onClick={() => s.setEdited(null)}>
                        undo my edits
                      </button>
                    </p>
                  )}
                </div>
              ) : (
                <div className="twsheet">
                  <Sheet text={s.document} changed={s.flaggedLines} idPrefix="rw" />
                  <p className="twcaption">
                    {toCheck.length > 0 ? (
                      <>
                        The marked lines are the ones the checker could not trace to your own
                        words. They are in the document — read them, and take out anything that
                        is not true of you.
                      </>
                    ) : (
                      <>
                        Every line here traces back to something already in your resume, checked
                        employer by employer. Nothing was added that you did not already say.
                      </>
                    )}
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <footer className="twbot">
        <span className="twcount">
          {rewrite ? (
            <>
              <b>{rewrite.kept}</b> lines verified
              {toCheck.length > 0 && (
                <span className="twflag"> · {toCheck.length} still to check</span>
              )}
            </>
          ) : (
            'Nothing written yet'
          )}
        </span>

        <button type="button" className="twghost" onClick={s.copy} disabled={!s.document}>
          {s.copied ? 'Copied' : 'Copy text'}
        </button>
        <button type="button" className="twghost" onClick={s.printable} disabled={!s.document}>
          Save as PDF
        </button>
        {/* The count travels with the button, because this is the moment the
            document stops being a draft and starts being something an employer
            reads. Not a block — it is their CV and their call — but not silent
            either. */}
        <button
          type="button"
          className={`twprimary${toCheck.length > 0 ? ' unchecked' : ''}`}
          onClick={() => void s.saveDocx()}
          disabled={!s.document || s.saving}
        >
          {s.saving
            ? 'Building…'
            : toCheck.length > 0
              ? `Download .docx · ${toCheck.length} unchecked`
              : 'Download .docx'}
        </button>
      </footer>

      {posting && s.res?.jobDescription && (
        <>
          <div className="twscrim" onClick={() => setPosting(false)} />
          <aside className="twdrawer" aria-label="The posting">
            <div className="twdrawerhead">
              <div>
                <h2>{jobTitle}</h2>
                <p className="tnote">
                  {company} · read live from the employer · nothing about this posting is stored
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
