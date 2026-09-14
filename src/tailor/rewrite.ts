import { claimTokens, containsClaim, normalise } from './edits.js';
import { evidenceFor, readShape, type ResumeShape } from './sections.js';
import { voiceProblems, uniformity, VOICE_RULES } from './voice.js';

/**
 * A whole tailored resume, written in one pass and checked line by line.
 *
 * WHY THIS REPLACED THE LINE-BY-LINE VERSION
 *
 * The first shipped version proposed individual edits and asked the person to
 * accept each one. Run for real, it produced seven suggestions of which the most
 * substantial moved "React.js" two words earlier. That is not a tuning problem.
 * Asking a model "which single lines would you change?" gets single-line answers,
 * and a resume that fits a different job needs a different resume — a summary
 * aimed at this employer, skills in an order that matches what they asked for,
 * and the bullets that matter to them at the top of each job.
 *
 * So it writes the document. The person gets a finished CV, not homework.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER TOOL THAT DOES THIS
 *
 * Every one of them will write you a tailored resume. None of them can tell you
 * which parts of it are true. This one refuses to emit a line it cannot trace,
 * and — the part that actually matters — it traces EMPLOYER BY EMPLOYER.
 *
 * A whole-document check is not enough and the failure is not hypothetical. If
 * Kubernetes appears anywhere in a CV, a document-level check will happily let a
 * bullet under a 2018 job claim it. That is a fabricated work history that passes
 * every test. So a bullet written under Infosys may only draw on the lines that
 * were already under Infosys, and a number may never move between jobs.
 *
 * THREE OUTCOMES PER LINE, AND THE MIDDLE ONE IS THE USEFUL ONE
 *
 *   kept      every claim traces to that employer's own lines
 *   ask       it says something true-looking that that employer's lines do not
 *             support — shown with the exact words, as a question
 *   dropped   unsupported and not worth asking about, or it broke a voice rule
 *
 * The "ask" case is the one nobody else has. "Did you use Kubernetes at Infosys?"
 * is a question only the candidate can answer, and asking it beats both guessing
 * and silently omitting.
 */

export interface RewrittenBullet {
  text: string;
  /** Lines from THIS employer that the claim rests on. */
  from: string[];
  /** Why it is here, for this posting. */
  why: string;
}

export interface RewrittenCompany {
  /** Matched back to the parsed resume by name. */
  company: string;
  role: string;
  header: string;
  bullets: RewrittenBullet[];
}

export interface RewriteAnswer {
  summary: string;
  summaryWhy: string;
  skills: string[];
  companies: RewrittenCompany[];
  /** Lines deliberately left out, and why. Never silent. */
  dropped: { text: string; why: string }[];
}

export type LineVerdict = 'kept' | 'ask' | 'dropped';

export interface CheckedLine {
  text: string;
  verdict: LineVerdict;
  /** Empty when kept. The words that could not be traced, or the rule broken. */
  note: string;
  unverified: string[];
  /** The question to put to the candidate, when the verdict is `ask`. */
  question?: string;
  why: string;
}

export interface CheckedCompany {
  company: string;
  role: string;
  header: string;
  lines: CheckedLine[];
}

export interface CheckedRewrite {
  summary: CheckedLine;
  skills: CheckedLine[];
  companies: CheckedCompany[];
  dropped: { text: string; why: string }[];
  kept: number;
  asked: number;
  discarded: number;
  /** Voice problems found in what survived, so the screen can say so. */
  voice: string[];
}

/**
 * How much of a quoted source line must be real.
 *
 * The model is asked to quote the line it drew on. A quote it half-remembers is
 * not evidence, but neither is it grounds to throw away a bullet whose claims all
 * check out independently — so the quote is a hint for the reader and the TOKEN
 * check below is the actual gate.
 */
const QUOTE_PREFIX = 30;

/** Whether an employer's own lines say this. */
function supportedBy(evidence: string, text: string): string[] {
  return claimTokens(text).filter((t) => !containsClaim(evidence, t));
}

/**
 * One rewritten bullet, checked against ONE employer's lines.
 *
 * Not against the resume. That distinction is the whole point of this module:
 * "did they ever do this" and "did they do this HERE" are different questions,
 * and only the second one is what a bullet under a job claims.
 */
export function checkBullet(
  bullet: RewrittenBullet,
  employerEvidence: string,
  wholeResume: string,
): CheckedLine {
  const text = bullet.text.trim();
  const base: Omit<CheckedLine, 'verdict' | 'note'> = {
    text,
    unverified: [],
    why: bullet.why,
  };

  if (!text) {
    return { ...base, verdict: 'dropped', note: 'empty' };
  }

  const problems = voiceProblems([text]);
  if (problems.length > 0) {
    const p = problems[0]!;
    return {
      ...base,
      verdict: 'dropped',
      note:
        p.kind === 'banned word'
          ? `uses "${p.detail}", which is the kind of word that makes a CV read as machine-written`
          : `ends with ", ${p.detail}…" — a result clause the resume never measured`,
    };
  }

  const unverified = supportedBy(employerEvidence, text);
  if (unverified.length === 0) {
    return { ...base, verdict: 'kept', note: '' };
  }

  // It does not check out for THIS employer. Does it check out anywhere in the
  // resume? If so the candidate plainly knows the thing, and the only open
  // question is whether they used it in this job — which is worth asking. If it
  // appears nowhere, there is nothing to ask about and it is dropped.
  const elsewhere = unverified.filter((t) => containsClaim(wholeResume, t));
  const nowhere = unverified.filter((t) => !containsClaim(wholeResume, t));

  if (nowhere.length > 0) {
    return {
      ...base,
      verdict: 'dropped',
      unverified: nowhere,
      note: `${nowhere.map((u) => `"${u}"`).join(', ')} ${nowhere.length === 1 ? 'is' : 'are'} nowhere in your resume`,
    };
  }

  const words = elsewhere.map((u) => `"${u}"`).join(', ');
  return {
    ...base,
    verdict: 'ask',
    unverified: elsewhere,
    note: `your resume shows ${words}, but not at this job`,
    question: `Did you use ${elsewhere.join(', ')} at ${'this employer'}? Only keep this if you did.`,
  };
}

/**
 * The summary and the skills list, which are about the person and not about one
 * job, and so are checked against the whole resume.
 *
 * That is not a loophole. A summary saying "six years building .NET services" is
 * a claim about a career, and the career is the whole document. A bullet under one
 * employer is a claim about that job. Different claims, different evidence.
 */
function checkWhole(text: string, wholeResume: string, why: string): CheckedLine {
  const t = text.trim();
  if (!t) return { text: t, verdict: 'dropped', note: 'empty', unverified: [], why };

  const problems = voiceProblems([t]);
  if (problems.length > 0) {
    const p = problems[0]!;
    return {
      text: t,
      verdict: 'dropped',
      unverified: [],
      why,
      note:
        p.kind === 'banned word'
          ? `uses "${p.detail}"`
          : `ends with a result clause the resume never measured`,
    };
  }

  const unverified = supportedBy(wholeResume, t);
  if (unverified.length === 0) return { text: t, verdict: 'kept', note: '', unverified: [], why };
  return {
    text: t,
    verdict: 'ask',
    unverified,
    why,
    note: `${unverified.map((u) => `"${u}"`).join(', ')} ${unverified.length === 1 ? 'is' : 'are'} not in your resume`,
    question: `Is it true that you ${unverified.join(', ')}?`,
  };
}

/**
 * A whole rewritten resume, checked.
 *
 * Every company the model wrote is matched back to a company that exists in the
 * parsed resume. One that matches nothing is discarded entirely — an invented
 * employer is the largest fabrication this feature could produce, and it would
 * otherwise arrive looking exactly like the real ones.
 */
export function checkRewrite(answer: RewriteAnswer, resumeText: string): CheckedRewrite {
  const shape: ResumeShape = readShape(resumeText);
  const whole = resumeText;

  const summary = checkWhole(answer.summary, whole, answer.summaryWhy);
  const skills = answer.skills.map((s) => checkWhole(s, whole, 'ordered for this posting'));

  const companies: CheckedCompany[] = [];
  const dropped = [...answer.dropped];

  for (const rc of answer.companies) {
    const source = shape.companies.find(
      (c) =>
        normalise(c.name) === normalise(rc.company) ||
        normalise(c.header).includes(normalise(rc.company)) ||
        normalise(rc.company).includes(normalise(c.name)),
    );

    if (!source) {
      // An employer that is not in the resume. Not shown, not asked about —
      // there is no honest version of this.
      dropped.push({
        text: `${rc.company} — ${rc.bullets.length} bullets`,
        why: 'that employer is not in your resume',
      });
      continue;
    }

    const evidence = evidenceFor(source);
    companies.push({
      company: source.name,
      role: rc.role.trim() || source.role,
      header: source.header,
      lines: rc.bullets.map((b) => {
        const checked = checkBullet(b, evidence, whole);
        return checked.question
          ? { ...checked, question: checked.question.replace('this employer', source.name) }
          : checked;
      }),
    });
  }

  const all = [summary, ...skills, ...companies.flatMap((c) => c.lines)];
  const count = (v: LineVerdict) => all.filter((l) => l.verdict === v).length;

  // Uniformity is a property of a SET of bullets, so it is measured per employer
  // over the lines that survived rather than on any one of them.
  const voice: string[] = [];
  for (const c of companies) {
    const kept = c.lines.filter((l) => l.verdict !== 'dropped').map((l) => l.text);
    const u = uniformity(kept);
    if (u) voice.push(`${c.company}: ${u}`);
  }

  return {
    summary,
    skills,
    companies,
    dropped,
    kept: count('kept'),
    asked: count('ask'),
    discarded: count('dropped'),
    voice,
  };
}

/**
 * The finished document, as text.
 *
 * Only what was kept, plus anything the candidate confirmed. A line still waiting
 * on an answer is NOT in the document — an unanswered question is not a yes, and
 * the download must never contain something nobody has stood behind.
 */
export function assembleRewrite(
  checked: CheckedRewrite,
  shape: ResumeShape,
  confirmed: ReadonlySet<string>,
): string {
  const out: string[] = [];
  const take = (l: CheckedLine) => l.verdict === 'kept' || confirmed.has(l.text);

  if (shape.name) out.push(shape.name);
  for (const c of shape.contact) out.push(c);
  out.push('');

  if (take(checked.summary)) {
    out.push(checked.summary.text, '');
  }

  const skills = checked.skills.filter(take).map((l) => l.text);
  if (skills.length > 0) {
    out.push('TECHNICAL SKILLS');
    out.push(...skills);
    out.push('');
  }

  if (checked.companies.length > 0) {
    out.push('PROFESSIONAL EXPERIENCE');
    for (const c of checked.companies) {
      const lines = c.lines.filter(take);
      if (lines.length === 0) continue;
      out.push(c.header);
      if (c.role) out.push(c.role);
      for (const l of lines) out.push(`· ${l.text}`);
      out.push('');
    }
  }

  if (shape.education.length > 0) {
    out.push('EDUCATION');
    out.push(...shape.education);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export { VOICE_RULES };
