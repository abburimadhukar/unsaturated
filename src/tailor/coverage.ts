import { claimTokens, containsClaim, normalise } from './edits.js';

/**
 * What the posting asks for, and the honest answer for each one.
 *
 * WHY THIS IS NOT THE OLD `requirements` LIST
 *
 * The old one had four answers — strong, partial, missing, unknown — and on a
 * real posting it produced eleven rows reading NOT FOUND, of which two were not
 * skills at all ("Hybrid work in Boston, MA", "US Citizenship or Green Card
 * Holder status"). Several of the rest were wrong in a way that mattered:
 *
 *   OpenTofu     "not found" — against a resume listing Terraform. OpenTofu IS
 *                Terraform; it is a fork of it, and the posting itself said
 *                "Terraform or OpenTofu".
 *   AWS          "not found" — against a resume full of Azure. Not the same
 *                thing, but not nothing either, and "you have the equivalent on
 *                another cloud" is what the candidate needs to hear.
 *   Datadog      "not found" — against Splunk and AppInsights.
 *   Linux        "not found" — from somebody running Docker and Kubernetes.
 *
 * Eleven red rows telling a competent platform engineer they have nothing is both
 * wrong and useless. Huntr, the best-reviewed tool in this space, is praised for
 * exactly the thing missing here: "semantic matching that evaluates substance,
 * not just word overlap", and showing "which resume elements already match the
 * role, even with different phrasing".
 *
 * So there are two changes. A fifth answer, `adjacent` — you have the equivalent,
 * here it is, say so in your covering letter. And `eligibility` is separated from
 * skills, because a work-authorisation requirement is a fact about a person and
 * not a gap in their CV, and listing it as a missing skill is nonsense.
 */

/** Must-have, nice-to-have, or not a skill at all. */
export type Need = 'must' | 'nice' | 'eligibility';

export type Answer =
  /** Demonstrated in an experience line. */
  | 'shown'
  /** Named in skills or education, but not demonstrated in a job. */
  | 'partial'
  /** Not this, but the equivalent — and the equivalent is named. */
  | 'adjacent'
  /** Nowhere, in any form. */
  | 'missing'
  /** Too ambiguous to judge, or the evidence could not be confirmed. */
  | 'unclear';

export interface Requirement {
  /** What the posting asks for. */
  name: string;
  need: Need;
  answer: Answer;
  /** Quoted from the posting, so the requirement is not the model's invention. */
  fromPosting: string;
  /** Quoted from the resume. Empty for missing and unclear. */
  fromResume: string;
  /** For `adjacent` only: the thing they have instead, named. */
  insteadYouHave: string;
  /** One sentence on what to do about it. */
  advice: string;
  /** Set when the checker disagreed with the model, and why. */
  note?: string;
}

export interface Tally {
  must: { total: number; covered: number; adjacent: number; missing: number };
  nice: { total: number; covered: number; adjacent: number; missing: number };
  eligibility: Requirement[];
}

/** `shown` and `partial` both count as covered; `adjacent` is counted apart. */
function isCovered(a: Answer): boolean {
  return a === 'shown' || a === 'partial';
}

export function tally(reqs: readonly Requirement[]): Tally {
  const empty = () => ({ total: 0, covered: 0, adjacent: 0, missing: 0 });
  const out: Tally = { must: empty(), nice: empty(), eligibility: [] };
  for (const r of reqs) {
    if (r.need === 'eligibility') {
      out.eligibility.push(r);
      continue;
    }
    const b = r.need === 'nice' ? out.nice : out.must;
    b.total += 1;
    if (isCovered(r.answer)) b.covered += 1;
    else if (r.answer === 'adjacent') b.adjacent += 1;
    else if (r.answer === 'missing') b.missing += 1;
  }
  return out;
}

/**
 * The headline, in words rather than a number.
 *
 * NO PERCENTAGE, AND NOW NOT EVEN A SCORE
 *
 * Huntr grades coverage "poor, fair or great" rather than as a percentage, which
 * is the right instinct — but a word still hides the arithmetic. "8 of 11
 * must-haves, 2 more you have the equivalent of" can be checked by opening the
 * list, and that is the whole design of this tool.
 */
export function describeTally(t: Tally): string {
  const parts: string[] = [];
  if (t.must.total > 0) {
    parts.push(`${t.must.covered} of ${t.must.total} must-haves`);
    if (t.must.adjacent > 0) parts.push(`${t.must.adjacent} you have the equivalent of`);
    if (t.must.missing > 0) parts.push(`${t.must.missing} genuinely missing`);
  }
  if (t.nice.total > 0) parts.push(`${t.nice.covered} of ${t.nice.total} nice-to-haves`);
  return parts.join(' · ');
}

/** A quote has to be findable, allowing for a model tidying whitespace. */
export function quoteIsReal(resumeText: string, quote: string): boolean {
  const q = normalise(quote);
  if (q.length < 8) return false;
  const hay = normalise(resumeText);
  return hay.includes(q) || (q.length > 40 && hay.includes(q.slice(0, 40)));
}

/**
 * The model's answers, with every claim of evidence checked.
 *
 * DOWNGRADED, NEVER DROPPED
 *
 * A requirement whose evidence cannot be found is still a requirement the
 * employer has. Removing it would hide something they asked for, which is the one
 * thing this list must never do. It becomes `unclear`, which is the honest
 * reading: they want this and we could not confirm you have it.
 *
 * And `adjacent` is held to the same standard as the rest. "You have Terraform
 * instead" is a claim about the resume, so Terraform has to be in the resume — an
 * unverifiable equivalence is worse than none, because it reads as reassurance.
 */
export function checkRequirements(
  reqs: readonly Requirement[],
  resumeText: string,
): Requirement[] {
  return reqs.map((r) => {
    if (r.need === 'eligibility') {
      // Not a claim about the CV, so there is nothing to check against it.
      return { ...r, fromResume: '', insteadYouHave: r.insteadYouHave };
    }

    if (r.answer === 'adjacent') {
      if (!r.insteadYouHave.trim()) {
        return {
          ...r,
          answer: 'unclear' as Answer,
          note: 'the model said you have an equivalent but did not name it',
        };
      }
      // Checked as CLAIMS, not as a quote.
      //
      // `insteadYouHave` names the equivalent — "Docker, Kubernetes, Helm charts,
      // Shell Scripting and Bash Scripting" — and a name is not a sentence lifted
      // out of the CV. Demanding a verbatim quote here downgraded two correct
      // answers on the first real run: Azure offered against an AWS requirement,
      // and Docker/Kubernetes/Bash offered against Linux fundamentals. Every one
      // of those tools was in the resume; the phrasing was the model's.
      //
      // So it uses the same check as everything else in this codebase: every
      // number and technical name in the claim has to trace back. A fabricated
      // equivalent still fails, and a true one written in the model's own words
      // no longer does.
      const unverified = claimTokens(r.insteadYouHave).filter(
        (t) => !containsClaim(resumeText, t),
      );
      if (unverified.length > 0) {
        return {
          ...r,
          answer: 'unclear' as Answer,
          fromResume: '',
          note: `it offered ${unverified.map((u) => `"${u}"`).join(', ')} as the equivalent, which ${unverified.length === 1 ? 'is' : 'are'} not in your resume`,
        };
      }
      return r;
    }

    if (!isCovered(r.answer)) {
      // A quote attached to "missing" is a contradiction, and the dangerous
      // reading is the one where the quote wins. It is moved into the note rather
      // than deleted, so the contradiction is visible instead of tidied away.
      return r.fromResume
        ? {
            ...r,
            fromResume: '',
            note: `it called this ${r.answer} but also quoted “${r.fromResume}” — the two do not agree`,
          }
        : r;
    }

    if (!r.fromResume.trim()) {
      return {
        ...r,
        answer: 'unclear' as Answer,
        note: 'the model said your resume shows this but quoted nothing from it',
      };
    }
    if (!quoteIsReal(resumeText, r.fromResume)) {
      // The quote is repeated in the note. It cannot stand in the evidence slot,
      // where it would read as confirmation — but hiding what was claimed leaves
      // somebody unable to see what went wrong, and it is the thing they would
      // most want to look up in their own CV.
      return {
        ...r,
        answer: 'unclear' as Answer,
        fromResume: '',
        note: `it quoted “${r.fromResume}” as evidence, and that sentence is not in your resume`,
      };
    }
    return r;
  });
}

/** Worst first within each group, because a gap is the most useful line on the page. */
export function orderForReading(reqs: readonly Requirement[]): Requirement[] {
  const needRank: Record<Need, number> = { must: 0, nice: 1, eligibility: 2 };
  const answerRank: Record<Answer, number> = {
    missing: 0,
    adjacent: 1,
    unclear: 2,
    partial: 3,
    shown: 4,
  };
  return [...reqs].sort(
    (a, b) => needRank[a.need] - needRank[b.need] || answerRank[a.answer] - answerRank[b.answer],
  );
}
