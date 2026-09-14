'use client';

import { useMemo } from 'react';

import { changeRatio, diffWords } from '../../src/tailor/diff.js';
import type { DomainRead, SkillMatch } from '../../src/tailor/analysis.js';
import { changedLines, readResume } from '../../src/ui/resume-render.js';

/**
 * The pieces both tailoring screens are built from.
 *
 * WHY THEY LIVE HERE RATHER THAN IN EITHER SCREEN
 *
 * There are two: the panel inside a feed card, for deciding whether a job is
 * worth the effort, and the full workspace at /tailor, for doing the work. They
 * show the same edits, the same diff and the same document.
 *
 * Written twice they would drift — and the symptom would be the nastiest kind:
 * a change that reads one way in the feed and another on the page it links to,
 * about the same sentence of the same CV. The JobCard was extracted for exactly
 * this reason and its header says so. This is the same fix applied earlier.
 */

export interface Edit {
  original: string;
  replacement: string;
  reason: string;
  section?: string;
}

export interface CheckedEdit {
  edit: Edit;
  verdict: 'accepted' | 'flagged' | 'rejected';
  note: string;
  unverified: string[];
}

/** One line, with the words that changed marked. */
export function Diff({ before, after }: { before: string; after: string }) {
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

/**
 * The resume, shown as a document.
 *
 * A monospace textarea contains everything and looks like nothing. The one
 * question a person has in front of a tailored CV is "would I send this?", and
 * that cannot be answered from a text box — so this renders the thing.
 *
 * THE CHANGED LINES ARE MARKED IN PLACE
 *
 * Which is the reason to show the document at all rather than only the list of
 * edits. A sentence reads differently inside the paragraph it belongs to: a bullet
 * that looked like an improvement on its own can turn out to repeat the line above
 * it, and nothing but seeing them together reveals that.
 *
 * EVERY BLOCK CARRIES ITS SOURCE LINE AS AN ID
 *
 * So the changes list can drive the document. Clicking a change scrolls the
 * resume to that line and flashes it — the one idea worth taking from Jobscan,
 * whose left panel is navigation INTO the CV rather than a second list to read
 * alongside it. Two parallel lists a person has to join up in their head is
 * markedly worse than one list that moves the other.
 *
 * NOT A FACSIMILE, AND THE PAGE SAYS SO
 *
 * It is a reading of the TEXT. For the generated .docx that is exactly what
 * downloads. For the in-place edit of somebody's own file it is not — their layout
 * survives there and this shows their words in a default one, so the caption below
 * the sheet states which file the preview corresponds to rather than letting
 * somebody assume.
 */
export function Sheet({
  text,
  changed,
  idPrefix = 'tl',
  flash = null,
  handEdited,
}: {
  text: string;
  changed: Set<number>;
  /** Lines the person typed themselves, marked apart from the accepted ones. */
  handEdited?: Set<number>;
  idPrefix?: string;
  /** The line to pulse, having just been jumped to from the changes list. */
  flash?: number | null;
}) {
  const blocks = useMemo(() => readResume(text), [text]);
  return (
    <div className="sheet" role="document" aria-label="your tailored resume">
      {blocks.map((b, i) => {
        if (b.kind === 'blank') return <div className="sgap" key={i} />;
        const mark =
          (changed.has(b.line) ? ' schanged' : '') +
          (handEdited?.has(b.line) ? ' shandedited' : '') +
          (flash === b.line ? ' sflash' : '');
        const id = `${idPrefix}-${b.line}`;
        if (b.kind === 'name') return <h2 id={id} className={`sname${mark}`} key={i}>{b.text}</h2>;
        if (b.kind === 'contact') return <p id={id} className={`scontact${mark}`} key={i}>{b.text}</p>;
        if (b.kind === 'heading') return <h3 id={id} className={`shead${mark}`} key={i}>{b.text}</h3>;
        if (b.kind === 'bullet') {
          return (
            <p id={id} className={`sbullet${mark}`} key={i}>
              <span className="smarker">{b.marker ?? '·'}</span>
              <span>{b.text}</span>
            </p>
          );
        }
        return <p id={id} className={`sbody${mark}`} key={i}>{b.text}</p>;
      })}
    </div>
  );
}

/**
 * Where in the document a given replacement ended up.
 *
 * Returns the first line, because the scroll can only go to one place. The Set
 * from changedLines marks every occurrence, which is right for highlighting and
 * wrong for jumping.
 */
export function lineOf(text: string, replacement: string): number | null {
  const hit = changedLines(text, [replacement]);
  for (const line of hit) return line;
  return null;
}

export interface EditCardProps {
  checked: CheckedEdit;
  decision: 'taken' | 'skipped' | undefined;
  onTake: () => void;
  onSkip: () => void;
  /** Clicking the body of the card, rather than a button. Drives the document. */
  onSelect?: () => void;
  selected?: boolean;
}

/**
 * One suggested change.
 *
 * THE ACCEPTED STATE IS THE LOUD ONE
 *
 * It was the quiet one. Both buttons shared a `:disabled { opacity: .5 }`, so
 * accepting a change FADED it and left "Skip" the only solid thing on the card —
 * the unchosen option reading as the chosen one. With seven changes and two
 * accepted there was nothing on screen that answered "which ones are in?" without
 * counting. Now the taken state is a filled, ticked button and the card carries a
 * green rule.
 */
export function EditCard({
  checked,
  decision,
  onTake,
  onSkip,
  onSelect,
  selected,
}: EditCardProps) {
  const c = checked;
  const pct = Math.round(changeRatio(c.edit.original, c.edit.replacement) * 100);
  // A change that REWRITES a line is not the same event as one that swaps a word,
  // and rendering both at the same weight is how the biggest edit in the list —
  // the one most likely to have thrown away the thing that made the CV worth
  // reading — gets waved through.
  const heavy = pct >= 40;

  return (
    <div
      className={[
        'tedit',
        c.verdict,
        decision ?? '',
        selected ? 'sel' : '',
        heavy ? 'heavy' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={(e) => {
        if (!onSelect) return;
        if ((e.target as HTMLElement).closest('button')) return;
        onSelect();
      }}
    >
      <div className="tmeta">
        <span className={`tverdict ${c.verdict}`}>
          {c.verdict === 'accepted' ? 'verified' : 'your call'}
        </span>
        {c.edit.section && <span className="tsection">{c.edit.section}</span>}
        <span className={`tpct${heavy ? ' heavy' : ''}`}>
          {heavy ? 'rewrites this line · ' : ''}
          {pct}%
        </span>
      </div>

      <Diff before={c.edit.original} after={c.edit.replacement} />

      <p className="treason">{c.edit.reason}</p>

      {/* The warning sits between the change and the button that takes it, so it
          cannot be accepted without having been passed. */}
      {c.verdict === 'flagged' && <p className="twarn">⚠ {c.note}</p>}

      <div className="tbuttons">
        <button
          type="button"
          className={`ttake${decision === 'taken' ? ' done' : ''}`}
          onClick={onTake}
          disabled={decision === 'taken'}
        >
          {decision === 'taken'
            ? '✓ In your resume'
            : c.verdict === 'flagged'
              ? 'It is true — use it'
              : 'Use this'}
        </button>
        <button
          type="button"
          className="tskip"
          onClick={onSkip}
          disabled={decision === 'skipped'}
        >
          {decision === 'skipped' ? 'Skipped' : 'Skip'}
        </button>
      </div>
    </div>
  );
}

/** What the posting wants that the resume does not show. */
export function Gaps({ gaps }: { gaps: string[] }) {
  if (gaps.length === 0) return null;
  return (
    <div className="tgaps">
      <strong>What this posting wants that your resume does not show</strong>
      <ul>
        {gaps.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
      <p className="tnote">
        Named rather than written around. Only you can close these, and only if
        they are true.
      </p>
    </div>
  );
}

/**
 * The ones thrown away.
 *
 * Shown because it is the evidence that the checking is real. A person who has
 * watched a fabricated number get discarded has a reason to trust the ones that
 * were not.
 */
export function Discarded({ items }: { items: CheckedEdit[] }) {
  if (items.length === 0) return null;
  return (
    <details className="tdiscarded">
      <summary>{items.length} thrown away before you saw them</summary>
      {items.map((c, i) => (
        <div key={i} className="tdrop">
          <span className="tdroptext">{c.edit.replacement || '(empty)'}</span>
          <span className="tdropwhy">{c.note}</span>
        </div>
      ))}
    </details>
  );
}

/**
 * The analysis: what the posting asks for, and whether the CV shows it.
 *
 * WHY THIS SITS ABOVE THE CHANGES AND NOT BELOW THEM
 *
 * Because it answers the question somebody actually has. The first real run of
 * this feature produced seven line rewrites, of which the most substantial moved
 * "React.js" two words earlier — and, in the same call, told the candidate that a
 * defence-autonomy employer wanted WebGL, geospatial work, C++ and experience of
 * systems that keep working over intermittent radio links, none of which their CV
 * showed. One of those is worth reading before applying. The other seven are
 * housekeeping.
 *
 * NO SCORE, DELIBERATELY
 *
 * "4 of 13 required qualifications evidenced" is countable — the reader can open
 * the list and check all thirteen. An 84% match is a number produced by a method
 * nobody publishes, and this whole feature is built on the opposite idea.
 */
const STATUS_LABEL: Record<string, string> = {
  strong: 'shown',
  partial: 'partly',
  missing: 'not found',
  unknown: 'unconfirmed',
};

export function Analysis({
  requirements,
  coverageNote,
  domain,
}: {
  requirements: SkillMatch[];
  coverageNote: string;
  domain?: DomainRead;
}) {
  if (requirements.length === 0) return null;

  // Worst first. A requirement the candidate does not meet is the most useful
  // line on the page, and burying it under the ones they do meet is how a person
  // reads the top three and stops.
  const order: Record<string, number> = { missing: 0, unknown: 1, partial: 2, strong: 3 };
  const sorted = [...requirements].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'required' ? -1 : 1) ||
      (order[a.status] ?? 9) - (order[b.status] ?? 9),
  );

  return (
    <section className="tan">
      {domain?.name && (
        <p className="tandomain">
          <span className="tanlabel">They build</span> {domain.name}
        </p>
      )}
      <p className="tancover">{coverageNote}</p>

      <div className="tanlist">
        {sorted.map((r, i) => (
          <details key={i} className={`tanrow ${r.status}`}>
            <summary>
              <span className={`tanstatus ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
              <span className="tanname">{r.name}</span>
              {r.kind === 'preferred' && <span className="tankind">preferred</span>}
            </summary>
            <div className="tanbody">
              {r.jdEvidence && (
                <p className="tanquote">
                  <span className="tanlabel">They ask</span> “{r.jdEvidence}”
                </p>
              )}
              {r.resumeEvidence && (
                <p className="tanquote">
                  <span className="tanlabel">You wrote</span> “{r.resumeEvidence}”
                </p>
              )}
              {/* Present only when the verifier disagreed with the model, which
                  is exactly when the reader most needs to know. */}
              {r.note && <p className="tannote">⚠ {r.note}</p>}
              {r.action && <p className="tanaction">{r.action}</p>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
