import { verifyEdit, type Edit } from './edits.js';

/**
 * The whole resume, with the accepted changes in it.
 *
 * WHY THIS IS NOT A STRING REPLACE
 *
 * The obvious implementation is `text.replace(original, replacement)` per edit,
 * and it is wrong in three ways that all produce a damaged CV rather than an
 * error.
 *
 * DUPLICATES. A resume legitimately repeats a line — two roles at the same
 * employer, "Python and SQL" under two jobs. `String.replace` with a string
 * argument changes the FIRST occurrence, so two edits quoting the same line both
 * hit the same place and the second silently overwrites the first.
 *
 * OVERLAP. Applied in sequence against an already-modified document, an edit whose
 * anchor happens to sit inside text a previous edit rewrote no longer matches —
 * and it is dropped with no explanation, which looks like the model having
 * proposed fewer changes than it did.
 *
 * DRIFT. The suggestions were computed against the resume as it was. If it has
 * been edited since — a different tab, a different device — an anchor may match
 * somewhere it did not mean, and a line would be replaced on the strength of a
 * coincidence.
 *
 * So this works LINE BY LINE over an explicit array, claiming each line at most
 * once, and re-verifies every edit against the resume before touching anything.
 *
 * WHY IT RE-VERIFIES WHAT WAS ALREADY CHECKED
 *
 * The edits arrive from a browser, which means they arrive from whatever the
 * browser chose to send. They were checked when they were proposed; nothing
 * guarantees they are the same objects. Re-checking here costs microseconds and
 * makes the promise — no number and no tool that is not already in the resume —
 * a property of the document rather than of one request path being well behaved.
 *
 * It also catches drift for free: an anchor that no longer appears fails the same
 * check for a different reason.
 */

/** Whitespace and case folded, for matching a line that may have been reflowed. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface RefusedEdit {
  edit: Edit;
  /** Plain words. Shown to the person, so never a code. */
  why: string;
}

export interface Assembled {
  /** The full resume with the applied edits in place. */
  text: string;
  /** How many edits made it in. */
  applied: number;
  /** Edits that did not, and why each one did not. */
  refused: RefusedEdit[];
  /** True when the text differs from what went in. */
  changed: boolean;
}

/**
 * Applies the chosen edits to a resume.
 *
 * Every edit is re-verified, and a `flagged` one IS applied — the person accepted
 * it, and accepting an unprovable claim is a decision they are allowed to make
 * about their own history. What cannot be applied is an edit that is structurally
 * broken or whose line is no longer there; those come back in `refused` with a
 * reason, because silently dropping a change somebody clicked is the one outcome
 * that would make this untrustworthy.
 */
export function applyEdits(resumeText: string, edits: readonly Edit[]): Assembled {
  const lines = resumeText.split('\n');
  /** Line indexes already rewritten, so two edits cannot claim the same line. */
  const claimed = new Set<number>();
  const refused: RefusedEdit[] = [];
  let applied = 0;

  for (const edit of edits) {
    const checked = verifyEdit(edit, resumeText);
    if (checked.verdict === 'rejected') {
      refused.push({ edit, why: checked.note });
      continue;
    }

    const wanted = fold(edit.original);

    // A whole line, which is what a resume bullet is and what the model is asked
    // to quote. First unclaimed match wins, so repeated lines are consumed in
    // order rather than all collapsing onto the first.
    let at = lines.findIndex((line, i) => !claimed.has(i) && fold(line) === wanted);

    // Failing that, a sentence inside a longer line. Some CVs put a whole role on
    // one line, and a model quoting one clause of it is not wrong.
    if (at === -1) {
      at = lines.findIndex(
        (line, i) => !claimed.has(i) && fold(line).includes(wanted) && wanted.length > 0,
      );
      if (at !== -1) {
        // Replace within the line, preserving whatever surrounds the quoted part.
        // Located on the folded form and cut on the original so the untouched
        // remainder keeps its own spacing and capitals.
        const line = lines[at]!;
        const start = line.toLowerCase().indexOf(edit.original.trim().toLowerCase());
        if (start >= 0) {
          lines[at] = line.slice(0, start) + edit.replacement + line.slice(start + edit.original.trim().length);
          claimed.add(at);
          applied++;
          continue;
        }
        // The fold matched but the raw text does not, which means the line differs
        // by internal whitespace. Replacing the whole line is the honest option:
        // the fold said it is the same sentence.
        lines[at] = edit.replacement;
        claimed.add(at);
        applied++;
        continue;
      }
    }

    if (at === -1) {
      refused.push({
        edit,
        // Distinguished from "not in your resume" on purpose: verifyEdit already
        // confirmed the text IS in the resume, so reaching here means it is there
        // but not as a line of its own, or its line was already rewritten.
        why: 'that line was already changed by another edit, so this one was left out',
      });
      continue;
    }

    lines[at] = edit.replacement;
    claimed.add(at);
    applied++;
  }

  const text = lines.join('\n');
  return { text, applied, refused, changed: text !== resumeText };
}
