/**
 * Showing exactly what changed, word by word.
 *
 * WHY THIS IS NOT A PRESENTATION DETAIL
 *
 * The promise of this feature is "the least possible change". A before-and-after
 * pair does not demonstrate that — two sentences sitting one above the other look
 * about equally different whether four words moved or fourteen, and the reader has
 * to diff them in their head to find out.
 *
 * Marking the individual words is what makes the claim checkable at a glance. It
 * is also what makes the advice that actually works possible: the research on
 * AI-written resumes is consistent that what gets noticed is sameness, and the
 * single most effective habit is rewriting one phrase per bullet in your own
 * voice. You cannot do that to a paragraph you have not been shown the seams of.
 *
 * WORDS AND NOT CHARACTERS
 *
 * A character diff on prose produces confetti — it finds the shared 'e' in two
 * unrelated words and marks half a sentence as partially-kept. Words are the unit
 * a person reads and the unit they would retype.
 *
 * LONGEST COMMON SUBSEQUENCE, AND WHY IT IS AFFORDABLE
 *
 * O(n x m) in the word counts, which for two resume bullets is perhaps 30 x 30.
 * The naive alternative — walking both until they differ, then to the end — marks
 * everything after the first change as rewritten, which for a REORDERING marks
 * the entire line. Reordering is one of the six things the feature offers, so the
 * cheap algorithm would misreport the commonest case.
 */

export type Op = 'same' | 'added' | 'removed';

export interface Span {
  op: Op;
  text: string;
}

/**
 * Splits into words while keeping the punctuation attached.
 *
 * "infrastructure." and "infrastructure" are the same word to a reader and the
 * comma in "Docker, Kubernetes" is not a word at all. Splitting it off would mark
 * punctuation as an independent change every time a list was reordered.
 */
export function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/** Case and trailing punctuation ignored, so "Ran" and "ran," match. */
function same(a: string, b: string): boolean {
  const strip = (s: string) => s.toLowerCase().replace(/^[^\w$+#]+|[^\w$+#%]+$/g, '');
  return strip(a) === strip(b);
}

/**
 * The two lines as a run of spans.
 *
 * Adjacent spans of the same kind are merged, so the output reads as phrases
 * rather than as one element per word — which matters because the UI puts a
 * background on each span and a hundred boxes is unreadable.
 */
export function diffWords(before: string, after: string): Span[] {
  const a = words(before);
  const b = words(after);

  // Longest common subsequence table. a.length+1 by b.length+1, filled from the
  // end so the walk forward below can always take the larger remaining match.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = same(a[i]!, b[j]!)
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: Span[] = [];
  const push = (op: Op, text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += ` ${text}`;
    else out.push({ op, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i]!, b[j]!)) {
      // The word from AFTER, not from BEFORE. They compare equal but may differ
      // in case or punctuation, and what is shown has to be the text the person
      // would end up with.
      push('same', b[j]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push('removed', a[i]!);
      i++;
    } else {
      push('added', b[j]!);
      j++;
    }
  }
  while (i < a.length) push('removed', a[i++]!);
  while (j < b.length) push('added', b[j++]!);

  return out;
}

/**
 * How much of the line's CONTENT changed, 0 to 1.
 *
 * DELIBERATELY NOT COUNTED OFF THE SPANS ABOVE
 *
 * The first version counted the 'removed' spans, and it was wrong in the case
 * that matters most. A sequence diff cannot represent a MOVE — moving a phrase
 * from the end of a sentence to the front is expressed as deleting it there and
 * adding it here, so this reordering:
 *
 *   before  Built CI/CD pipelines with Docker and Kubernetes, cutting deploy
 *           time to 12 minutes
 *   after   Cutting deploy time to 12 minutes with Docker and Kubernetes CI/CD
 *           pipelines
 *
 * scored 54% changed when exactly one word — "Built" — actually left. Reordering
 * is one of the six things this feature offers and "Lead with my best" does
 * nothing else, so the commonest edit was being reported as the most invasive.
 *
 * So the number is a multiset difference: which of the person's words are no
 * longer present ANYWHERE in the result. That answers the question a reader is
 * actually asking — "how much of what I wrote did this change" — and a pure
 * reorder correctly reads as near zero, because a reorder changes no claim.
 *
 * diffWords stays sequence-based, because for SHOWING the change a reader needs
 * to see where the words went. The two functions answer different questions and
 * conflating them is what produced the wrong number.
 */
export function changeRatio(before: string, after: string): number {
  const key = (s: string) => s.toLowerCase().replace(/^[^\w$+#]+|[^\w$+#%]+$/g, '');
  const original = words(before);
  if (original.length === 0) return after.trim() ? 1 : 0;

  // A multiset, so a word used twice in the original and once in the result
  // counts as one loss rather than none.
  const remaining = new Map<string, number>();
  for (const w of words(after)) {
    const k = key(w);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }

  let lost = 0;
  for (const w of original) {
    const k = key(w);
    const left = remaining.get(k) ?? 0;
    if (left > 0) remaining.set(k, left - 1);
    else lost++;
  }
  return Math.min(1, lost / original.length);
}
