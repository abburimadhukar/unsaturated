/**
 * Keeping the words somebody typed themselves.
 *
 * THE BUG THIS FIXES
 *
 * The tailored document is rebuilt from the stored original every time a
 * suggestion is accepted or skipped. That is deliberate and it is what makes
 * "Skip" genuinely put a line back — a sentence cannot be un-spliced once a later
 * edit has overlapped it, so the document has to be a pure function of what is
 * ticked.
 *
 * But a person can also edit the document by hand, and hand edits were not part
 * of that function. So typing a better sentence and then accepting one more
 * suggestion silently threw the sentence away. Worse, it threw away exactly the
 * thing the page tells people to do: "change a phrase or two in your own words,
 * that is the single thing that keeps a tailored CV from reading like every other
 * one in the pile."
 *
 * So hand edits become operations, and the operations are replayed after every
 * rebuild. The document stays a pure function of (stored resume, accepted
 * suggestions, hand edits) and all three survive.
 *
 * NOT VERIFIED, AND THAT IS CORRECT
 *
 * The never-invent check applies to what a MODEL proposes. These are the person's
 * own words about their own history; they are the authority on it, and running
 * their sentence through a fabrication check would be the tool calling its owner
 * a liar. So hand edits are applied in the browser, after the server has built
 * the verified document, and the server's guarantee about the model's edits is
 * untouched.
 */

export type HandEdit =
  | { kind: 'replace'; from: string; to: string }
  | { kind: 'insert'; after: string; text: string }
  | { kind: 'remove'; line: string };

/** The line-level longest common subsequence, as a table of shared lengths. */
function lcs(a: readonly string[], b: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/**
 * What somebody did to a document, as operations rather than a new document.
 *
 * Anchored on line CONTENT and not on line numbers, because the rebuilt document
 * will have different line numbers the moment a suggestion above is accepted —
 * which is precisely the case that was losing the edit.
 *
 * Adjacent removals and insertions are paired into a replace, because that is
 * what editing a sentence looks like and a replace survives a rebuild that a
 * remove-then-insert would not.
 */
export function diffHandEdits(before: string, after: string): HandEdit[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const table = lcs(a, b);

  const ops: HandEdit[] = [];
  let i = 0;
  let j = 0;
  /** The last line present in BOTH documents, which an insertion hangs from. */
  let anchor = '';

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      anchor = a[i]!;
      i++;
      j++;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];
    // Walk the whole divergent run before deciding what it was, so a rewritten
    // sentence is one replace rather than a remove and an unrelated insert.
    while (i < a.length && j < b.length && a[i] !== b[j]) {
      if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        removed.push(a[i]!);
        i++;
      } else {
        added.push(b[j]!);
        j++;
      }
    }
    ops.push(...pair(removed, added, anchor));
    if (added.length > 0) anchor = added[added.length - 1]!;
    else if (removed.length > 0) anchor = ops.length > 0 ? anchor : anchor;
  }

  ops.push(...pair(a.slice(i), b.slice(j), anchor));
  return ops;
}

/** One divergent run, as replaces for as far as they pair and then the remainder. */
function pair(removed: string[], added: string[], anchor: string): HandEdit[] {
  const ops: HandEdit[] = [];
  const both = Math.min(removed.length, added.length);
  for (let k = 0; k < both; k++) {
    ops.push({ kind: 'replace', from: removed[k]!, to: added[k]! });
  }
  for (let k = both; k < removed.length; k++) {
    ops.push({ kind: 'remove', line: removed[k]! });
  }
  // An insertion hangs off the last line that is definitely still there: either
  // the last line the two documents agreed on, or the last line this run replaced.
  let at = both > 0 ? added[both - 1]! : anchor;
  for (let k = both; k < added.length; k++) {
    ops.push({ kind: 'insert', after: at, text: added[k]! });
    at = added[k]!;
  }
  return ops;
}

export interface Replayed {
  text: string;
  /** How many operations found their anchor and were applied. */
  applied: number;
  /** Operations whose line is no longer in the document, so they were dropped. */
  lost: HandEdit[];
}

/**
 * The person's own edits, put back on top of a freshly rebuilt document.
 *
 * An operation whose anchor line has gone — because a suggestion replaced the
 * very line they had edited — is REPORTED rather than forced somewhere
 * approximate. Guessing where a sentence belongs is how a CV ends up with a
 * bullet under the wrong employer.
 */
export function replayHandEdits(text: string, ops: readonly HandEdit[]): Replayed {
  const lines = text.split('\n');
  const lost: HandEdit[] = [];
  let applied = 0;

  for (const op of ops) {
    if (op.kind === 'replace') {
      const at = lines.indexOf(op.from);
      if (at < 0) {
        // Already the person's wording — a rebuild that produced the same line
        // twice must not apply the same edit twice.
        if (lines.includes(op.to)) continue;
        lost.push(op);
        continue;
      }
      lines[at] = op.to;
      applied++;
      continue;
    }

    if (op.kind === 'remove') {
      const at = lines.indexOf(op.line);
      if (at < 0) continue;
      lines.splice(at, 1);
      applied++;
      continue;
    }

    if (lines.includes(op.text)) continue;
    const at = op.after === '' ? -1 : lines.indexOf(op.after);
    if (at < 0 && op.after !== '') {
      lost.push(op);
      continue;
    }
    lines.splice(at + 1, 0, op.text);
    applied++;
  }

  return { text: lines.join('\n'), applied, lost };
}

/** Which lines of the final document the person wrote, so the sheet can mark them. */
export function handEditedLines(text: string, ops: readonly HandEdit[]): Set<number> {
  const wanted = new Set(
    ops.flatMap((o) => (o.kind === 'replace' ? [o.to] : o.kind === 'insert' ? [o.text] : [])),
  );
  const marked = new Set<number>();
  if (wanted.size === 0) return marked;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (wanted.has(lines[i]!)) marked.add(i);
  }
  return marked;
}
