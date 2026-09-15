'use client';

import { Diff } from './tailor-parts.js';
import type { CheckedLine, CheckedRewrite } from '../../src/tailor/rewrite.js';

/**
 * Every line that changed, with the original beside it and a way to put it back.
 *
 * WHY THIS EXISTS, FROM THE REVIEWS OF EVERY OTHER TOOL
 *
 * The complaint is the same one every time. Of the five tailoring tools ranked by
 * Huntr, three were marked down for it in the same words: "no selective approval —
 * all changes apply wholesale", "AI applies edits without approval", "rewrites may
 * remove existing metrics, weakening your resume". One was found to have "inserted
 * fabricated figures that had no basis in the original resume".
 *
 * The first shipped version of this feature had per-change control and no whole
 * document. The second had a whole document and no per-change control. Both halves
 * are needed: a rewrite you cannot partly reject is a rewrite you have to take on
 * trust, and the whole point of this tool is that you do not have to.
 *
 * ORIGINAL AND REWRITE, WORD BY WORD
 *
 * Not two paragraphs side by side to compare by eye — the words that actually
 * changed are marked, because "what did it do to this line" is the question and a
 * pair of similar sentences does not answer it.
 */

interface Change {
  line: CheckedLine;
  where: string;
}

/**
 * Only lines that replaced something, and only where the replacement differs.
 *
 * A flagged line belongs here as much as a verified one. It used to be excluded
 * along with the deleted ones, which meant the changes you were least sure about
 * were the ones you could not see the original for.
 */
export function changesIn(rewrite: CheckedRewrite): Change[] {
  const out: Change[] = [];
  const add = (line: CheckedLine, where: string) => {
    if (!line.original || line.original.trim() === line.text.trim()) return;
    out.push({ line, where });
  };
  add(rewrite.summary, 'Summary');
  for (const s of rewrite.skills) add(s, 'Skills');
  for (const c of rewrite.companies) for (const l of c.lines) add(l, c.company);
  return out;
}

export function Changes({
  rewrite,
  reverted,
  onRevert,
  onRestore,
}: {
  rewrite: CheckedRewrite;
  reverted: Set<string>;
  /** Put the person's own line back. */
  onRevert: (text: string) => void;
  /** Take the rewrite again. */
  onRestore: (text: string) => void;
}) {
  const changes = changesIn(rewrite);
  if (changes.length === 0) return null;

  const undone = changes.filter((c) => reverted.has(c.line.text)).length;

  return (
    <section className="chg">
      <div className="chghead">
        <strong>{changes.length} lines rewritten</strong>
        {undone > 0 && (
          <button
            type="button"
            className="tlink"
            onClick={() => changes.forEach((c) => onRestore(c.line.text))}
          >
            take all {changes.length} again
          </button>
        )}
        {undone === 0 && (
          <button
            type="button"
            className="tlink"
            onClick={() => changes.forEach((c) => onRevert(c.line.text))}
          >
            keep all my originals
          </button>
        )}
      </div>

      {changes.map((c, i) => {
        const isReverted = reverted.has(c.line.text);
        return (
          <div className={`chgrow${isReverted ? ' undone' : ''}`} key={i}>
            <div className="chgmeta">
              <span className="chgwhere">{c.where}</span>
              {isReverted && <span className="chgkept">your original</span>}
            </div>

            <Diff before={c.line.original} after={c.line.text} />

            {c.line.why && <p className="chgwhy">{c.line.why}</p>}

            <div className="tbuttons">
              {isReverted ? (
                <button
                  type="button"
                  className="ttake"
                  onClick={() => onRestore(c.line.text)}
                >
                  Use the rewrite
                </button>
              ) : (
                <button
                  type="button"
                  className="tskip"
                  onClick={() => onRevert(c.line.text)}
                >
                  Keep my original
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * The original and the tailored version, whole, side by side.
 *
 * A mode rather than a layout: two full resumes at once need the width of both,
 * and "what changed" is answered better by the list above. This is for the moment
 * before sending, when somebody wants to see the two documents as documents.
 */
export function CompareView({ before, after }: { before: string; after: string }) {
  return (
    <div className="cmp">
      <div className="cmpcol">
        <p className="cmphead">Your resume</p>
        <pre className="cmptext">{before}</pre>
      </div>
      <div className="cmpcol">
        <p className="cmphead">Tailored</p>
        <pre className="cmptext">{after}</pre>
      </div>
    </div>
  );
}
