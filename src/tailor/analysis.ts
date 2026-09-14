import { normalise } from './edits.js';

/**
 * What the posting asks for, and whether the resume shows it.
 *
 * WHY THIS EXISTS, FROM THE FIRST REAL RUN
 *
 * The feature shipped as a list of line rewrites. Run against a real posting with
 * a real model for the first time, the rewrites were nearly worthless — seven
 * suggestions, of which the most substantial moved "React.js" two words earlier
 * and made the English slightly worse. Nobody reading the CV would notice any of
 * them.
 *
 * The same call's GAPS were excellent:
 *
 *   No evidence of WebGL or OpenGL experience.
 *   No evidence of geospatial application development.
 *   No evidence of C++ fluency; the resume lists C, but not C++.
 *   No evidence of Command & Control, UAV, aircraft, autonomy or defense systems.
 *
 * That is worth reading. It answers "should I apply at all", which is the
 * question somebody actually has in front of a posting. So the analysis becomes
 * the product and the rewriting becomes the sideshow, and the gaps stop being an
 * optional chip that has to be turned on.
 *
 * NO SCORE
 *
 * Deliberately no percentage. An ATS match score is a number nobody can check,
 * computed from a method nobody publishes, and the whole point of this tool is
 * that every claim traces to a quote. "7 of 10 required, evidenced" is countable
 * by the person reading it — they can look at the seven.
 */

export type Requirement = 'required' | 'preferred';
export type Status = 'strong' | 'partial' | 'missing' | 'unknown';

export interface SkillMatch {
  /** The thing the posting asks for. */
  name: string;
  kind: Requirement;
  status: Status;
  /** Quoted from the posting, so the requirement is not the model's invention. */
  jdEvidence: string;
  /** Quoted from the resume. Empty when nothing supports it. */
  resumeEvidence: string;
  /** What the person could do about it, in one sentence. */
  action: string;
  /** Set when the verifier changed the model's answer, and why. */
  note?: string;
}

export interface Coverage {
  required: { strong: number; partial: number; missing: number; unknown: number; total: number };
  preferred: { strong: number; partial: number; missing: number; unknown: number; total: number };
}

/**
 * How much of a quoted evidence line must survive to count as a real quote.
 *
 * A model asked to quote will usually quote, and will sometimes tidy — dropping a
 * trailing clause, fixing a ligature, normalising a dash. Demanding a byte-exact
 * substring would discard evidence that is plainly present, and accepting
 * anything at all would make the check decorative. A leading run of the quote has
 * to be found verbatim.
 */
const QUOTE_PREFIX = 40;

/**
 * Whether the resume really says what the model says it says.
 *
 * THE CHECK THAT MAKES THE ANALYSIS WORTH ANYTHING
 *
 * A model that says "strong — the resume says you ran Kubernetes at scale" when
 * the resume says nothing of the sort is worse than no analysis, because it reads
 * as reassurance. So every claim of evidence is looked for in the resume, and a
 * claim that cannot be found is downgraded rather than shown.
 */
export function quoteIsInResume(resumeText: string, quote: string): boolean {
  const q = normalise(quote);
  if (q.length < 8) return false;
  const hay = normalise(resumeText);
  if (hay.includes(q)) return true;
  // A tidied quote: the front of it still has to be there verbatim.
  return q.length > QUOTE_PREFIX && hay.includes(q.slice(0, QUOTE_PREFIX));
}

/**
 * The model's analysis, with every evidenced claim checked against the resume.
 *
 * Downgrades rather than discards. A requirement whose evidence cannot be found
 * is still a requirement the posting has — dropping it would hide something the
 * employer asked for. It becomes `unknown`, which says "the posting wants this
 * and we could not confirm you have it", and that is the honest answer.
 */
export function verifySkillMatches(
  matches: readonly SkillMatch[],
  resumeText: string,
): SkillMatch[] {
  return matches.map((m) => {
    const claimsEvidence = m.status === 'strong' || m.status === 'partial';

    if (!claimsEvidence) {
      // A missing or unknown requirement must not carry evidence — a quote
      // attached to "missing" is a contradiction, and the safest reading is that
      // the model mislabelled one of the two.
      return m.resumeEvidence ? { ...m, resumeEvidence: '' } : m;
    }

    if (!m.resumeEvidence.trim()) {
      return {
        ...m,
        status: 'unknown' as Status,
        note: 'the model said your resume shows this but quoted nothing from it',
      };
    }

    if (!quoteIsInResume(resumeText, m.resumeEvidence)) {
      return {
        ...m,
        status: 'unknown' as Status,
        resumeEvidence: '',
        note: 'the quote given as evidence is not in your resume, so this could not be confirmed',
      };
    }

    return m;
  });
}

/** The counts, so somebody can check the summary against the list. */
export function coverage(matches: readonly SkillMatch[]): Coverage {
  const empty = () => ({ strong: 0, partial: 0, missing: 0, unknown: 0, total: 0 });
  const out: Coverage = { required: empty(), preferred: empty() };
  for (const m of matches) {
    const bucket = m.kind === 'preferred' ? out.preferred : out.required;
    bucket[m.status] += 1;
    bucket.total += 1;
  }
  return out;
}

/**
 * The one-line summary, written from the counts rather than by the model.
 *
 * Because a model asked to summarise its own analysis will round in the flattering
 * direction, and this is the sentence somebody reads instead of the list.
 */
export function describeCoverage(c: Coverage): string {
  const parts: string[] = [];
  const req = c.required;
  if (req.total > 0) {
    parts.push(`${req.strong} of ${req.total} required qualification${req.total === 1 ? '' : 's'} evidenced`);
    if (req.partial > 0) parts.push(`${req.partial} partly`);
    if (req.missing > 0) parts.push(`${req.missing} not found`);
    if (req.unknown > 0) parts.push(`${req.unknown} unconfirmed`);
  }
  const pref = c.preferred;
  if (pref.total > 0) {
    parts.push(`${pref.strong} of ${pref.total} preferred`);
  }
  return parts.join(' · ');
}

/**
 * The domain the employer works in, as the model read it off the posting.
 *
 * WHY THIS IS HERE AND NOT DECORATION
 *
 * The first real run, with "Cut what doesn't matter" on, deleted every mention of
 * AI from a CV — the summary's ML.NET and ONNX sentence, "scalable AI-backed
 * APIs", "powered by NLP and LLM-based content responses" — for a company that
 * builds autonomous aircraft swarms and Command & Control software. The model saw
 * "Full Stack Software Engineer" in the title, optimised for those words, and
 * discarded the single most differentiating thing on the page.
 *
 * It broke no rule doing it. Every rule was about not INVENTING, and this was a
 * failure of judgement about what to KEEP. So the domain is named explicitly and
 * the prompt is given a rule about it, and the person is shown what was decided
 * so they can disagree.
 */
export interface DomainRead {
  /** What the employer does, in a few words. */
  name: string;
  /** The terms in the posting that say so. */
  signals: string[];
}

/** Empty rather than absent, so the UI has one shape to render. */
export const NO_DOMAIN: DomainRead = { name: '', signals: [] };
