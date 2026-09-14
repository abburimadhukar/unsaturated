'use client';

import Link from 'next/link';
import { useState } from 'react';

import { PRESETS } from '../../src/tailor/rewrite-prompt.js';
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
 * asked of the person is the small number of questions software genuinely cannot
 * answer for them.
 *
 * THE THREE THINGS ON SCREEN, IN ORDER
 *
 *   1. The questions, if any. "Did you use Kubernetes at Infosys?" Each one is a
 *      line that is out of the document until it is answered yes. This is the
 *      only work, and there are usually none or a handful.
 *   2. The document, full width, at the measure it will be read at.
 *   3. What was cut, and why, collapsed. Available rather than insisted upon —
 *      but present, because a tool that silently shortens somebody's CV has taken
 *      a decision on their behalf without telling them.
 */

export interface RewriteWorkspaceProps {
  jobKey: string;
  jobTitle: string;
  company: string;
  applyUrl: string | null;
  closed: boolean;
}

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

  const rewrite = s.res?.rewrite ?? null;
  const dropped = rewrite?.dropped ?? [];

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
              Options{s.open.length > 0 ? ` · ${s.open.length}` : ''}
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

            <div className="tchips">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`tchip${s.presets.includes(p.id) ? ' on' : ''}`}
                  onClick={() => s.togglePreset(p.id)}
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>

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

          {/* ---- the only work there is ---- */}
          {s.open.length > 0 && (
            <section className="rwask">
              <h2>
                {s.open.length} question{s.open.length === 1 ? '' : 's'} only you can answer
              </h2>
              <p className="tnote">
                These lines say something your resume shows elsewhere but not at that job. They
                are out of your resume until you say yes.
              </p>
              {s.open.map((l, i) => (
                <div className="rwq" key={i}>
                  <p className="rwqtext">{l.text}</p>
                  <p className="rwqwhy">{l.note}</p>
                  <div className="tbuttons">
                    <button type="button" className="ttake" onClick={() => s.confirm(l.text)}>
                      Yes, that is true
                    </button>
                    <button type="button" className="tskip" onClick={() => s.decline(l.text)}>
                      No — leave it out
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {s.confirmed.size > 0 && (
            <p className="rwconfirmed">
              {s.confirmed.size} line{s.confirmed.size === 1 ? '' : 's'} added because you
              confirmed {s.confirmed.size === 1 ? 'it' : 'them'}.
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
              <summary>{dropped.length} lines left out of this version</summary>
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
                  Tailored for {company}
                  {s.open.length > 0 && (
                    <span className="twdim">
                      {' '}
                      · {s.open.length} line{s.open.length === 1 ? '' : 's'} held back pending your
                      answer
                    </span>
                  )}
                </span>
              </div>
              <div className="twsheet">
                <Sheet text={s.document} changed={new Set()} idPrefix="rw" />
                <p className="twcaption">
                  Every line here traces back to something already in your resume, checked
                  employer by employer. Nothing was added that you did not already say.
                </p>
              </div>
            </>
          )}
        </section>
      </div>

      <footer className="twbot">
        <span className="twcount">
          {rewrite ? (
            <>
              <b>{rewrite.kept}</b> lines verified
              {rewrite.asked > 0 && <span className="twdim"> · {rewrite.asked} asked</span>}
              {rewrite.discarded > 0 && (
                <span className="twdim"> · {rewrite.discarded} discarded</span>
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
        <button
          type="button"
          className="twprimary"
          onClick={() => void s.saveDocx()}
          disabled={!s.document || s.saving}
        >
          {s.saving ? 'Building…' : 'Download .docx'}
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
