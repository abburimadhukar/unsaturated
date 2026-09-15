import { checkRequirements, tally, type Requirement, type Tally } from './coverage.js';
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
 * THE CHECKER LABELS. IT DOES NOT DELETE.
 *
 * This module used to have a third verdict, `dropped`, and a line that earned it
 * never reached the screen at all. That was the wrong division of labour. Deciding
 * that a sentence about somebody's own career should not exist is not a decision
 * code is equipped to make: the resume it checks against is a summary, not a
 * complete record of a life, and "I cannot find evidence for this" is a statement
 * about the document, not about the person.
 *
 * So every line the model writes now arrives on the page. The checker's job is to
 * say what it could and could not trace, in the plainest words available, and the
 * person decides. There are two verdicts left:
 *
 *   kept      every claim traces to that employer's own lines
 *   flagged   something in it could not be traced — see `concern` for what
 *
 * WHAT THE CHECK STILL IS, BECAUSE THIS IS THE PART NOBODY ELSE HAS
 *
 * Every tool in this space will write you a tailored resume. None of them can tell
 * you which parts of it are true. This one traces every claim EMPLOYER BY
 * EMPLOYER, and that distinction is the whole point.
 *
 * A whole-document check is not enough and the failure is not hypothetical. If
 * Kubernetes appears anywhere in a CV, a document-level check will happily let a
 * bullet under a 2018 job claim it. That is a fabricated work history that passes
 * every other test in this repo. So a bullet written under Infosys is checked
 * against the lines that were already under Infosys, and a number that moves
 * between jobs is reported as having moved.
 *
 * Reporting rather than deleting does not weaken that. It moves the decision to
 * the only person who knows the answer.
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
  /** Lines THE MODEL chose to leave out, and why. Never the checker's doing. */
  dropped: { text: string; why: string }[];
  /** What the posting asks for, and the honest answer for each. */
  requirements: Requirement[];
}

export type LineVerdict = 'kept' | 'flagged';

/**
 * What the checker could not confirm. Never a reason to delete a line — only a
 * reason to put it in front of the person with the problem named.
 *
 * Ordered by how serious it is, which is the order they are tested in: a line that
 * claims something the resume never mentions is a bigger problem than a line that
 * claims something at the wrong job, and both matter more than a clumsy verb.
 */
export type Concern =
  /** Nothing to report. */
  | 'none'
  /** The employer itself is not in the resume. The largest thing that can go wrong. */
  | 'no-employer'
  /** The claim is nowhere in the resume, in any form. */
  | 'not-in-resume'
  /** The resume shows it — under a different employer. */
  | 'other-employer'
  /** Reads machine-written: a banned word, or a result clause nothing measured. */
  | 'voice';

export interface CheckedLine {
  text: string;
  /**
   * The line this replaced, when it replaced one.
   *
   * Kept so the person can put their own sentence back. Every review of this
   * category says the same thing about the tools that get it wrong — "no
   * selective approval, all changes apply wholesale" — and a rewrite you cannot
   * partly reject is a rewrite you have to take on trust.
   */
  original: string;
  verdict: LineVerdict;
  /** Empty when kept. What could not be traced, in words. */
  note: string;
  concern: Concern;
  unverified: string[];
  /** The question to put to the candidate, when there is one. */
  question?: string;
  why: string;
}

export interface CheckedCompany {
  company: string;
  role: string;
  header: string;
  /**
   * Whether this employer exists in the resume at all.
   *
   * False is the loudest thing on the page. It used to be the one case that was
   * deleted outright — an invented employer arrives looking exactly like a real
   * one, so the instinct was to make it never arrive. But a resume is often a
   * shortened version of a career, and "GOOGLE is not in your resume" is a
   * sentence somebody can act on, where silence is not.
   */
  inResume: boolean;
  lines: CheckedLine[];
}

export interface CheckedRewrite {
  summary: CheckedLine;
  skills: CheckedLine[];
  companies: CheckedCompany[];
  /** What the MODEL left out, with its reason. The checker adds nothing here. */
  dropped: { text: string; why: string }[];
  requirements: Requirement[];
  tally: Tally;
  /** Lines every claim of which traced back. */
  kept: number;
  /** Lines carrying something the checker could not confirm. */
  flagged: number;
  /** Voice problems found across the document, so the screen can say so. */
  voice: string[];
}

/** Whether an employer's own lines say this. */
function supportedBy(evidence: string, text: string): string[] {
  return claimTokens(text).filter((t) => !containsClaim(evidence, t));
}

const quoted = (words: readonly string[]): string => words.map((w) => `"${w}"`).join(', ');
const isAre = (words: readonly string[]): string => (words.length === 1 ? 'is' : 'are');

/**
 * Whether this exact sentence is already in the source — the person's own words,
 * carried through unchanged.
 */
function isTheirOwnSentence(source: string, text: string): boolean {
  const t = normalise(text);
  return t.length > 0 && normalise(source).includes(t);
}

/**
 * A voice problem as a sentence, or empty.
 *
 * `uniformity` is excluded deliberately: it is a property of a SET of bullets and
 * says nothing about any one of them, so attaching it to a single line would
 * accuse the wrong sentence. It is reported per employer instead.
 */
function voiceNote(text: string): string {
  const p = voiceProblems([text]).find((x) => x.kind !== 'uniform shape');
  if (!p) return '';
  return p.kind === 'banned word'
    ? `uses "${p.detail}", the kind of word that makes a CV read as machine-written`
    : `ends with ", ${p.detail}…", a result clause the resume never measured`;
}

/**
 * The voice note, unless the person wrote the sentence themselves.
 *
 * FROM A REAL RUN, AND THE CLEAREST ARGUMENT FOR NOT DELETING
 *
 * The resume said, in the candidate's own words:
 *
 *   "Migrated a monolithic ASP.NET application to .NET Core, reducing cold start
 *    from 14 seconds to 3."
 *
 * The model carried it through untouched, which is the best thing it can do with
 * a good line. The purpose-clause rule then fired on ", reducing" and reported
 * "a result clause the resume never measured" — about a clause the resume
 * measured, in a sentence the resume contains, word for word. Under the old code
 * that line was DELETED, and somebody's best bullet disappeared out of their CV
 * on a false charge.
 *
 * The voice rules exist to stop the MODEL writing like a machine. They have no
 * business grading prose the person already chose.
 */
function voiceNoteUnlessTheirs(source: string, text: string): string {
  return isTheirOwnSentence(source, text) ? '' : voiceNote(text);
}

/** Evidence first, voice second — and voice alone never outranks a clean trace. */
function withVoice(note: string, voice: string): string {
  if (!voice) return note;
  return note ? `${note} · it also ${voice}` : voice;
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
  const base: Omit<CheckedLine, 'verdict' | 'note' | 'concern'> = {
    text,
    // The first source line, which is the one it reads as a rewrite of. A bullet
    // merged from two lines reverts to the first; reverting to both would put
    // back something the person never had as a single line.
    original: (bullet.from[0] ?? '').trim(),
    unverified: [],
    why: bullet.why,
  };

  // An empty bullet is not a line somebody lost — there was never anything in it.
  // It carries no concern and is counted as nothing.
  if (!text) return { ...base, verdict: 'kept', concern: 'none', note: '' };

  // Against the whole resume, not this employer's lines: a sentence moved from
  // one job to another is still the person's own writing, and the evidence check
  // below is what has an opinion about where it sits.
  const voice = voiceNoteUnlessTheirs(wholeResume, text);
  const unverified = supportedBy(employerEvidence, text);

  if (unverified.length === 0) {
    // Everything traces. A clumsy verb is still worth saying out loud, but it is
    // the mildest thing on this list and it never used to survive at all.
    return voice
      ? { ...base, verdict: 'flagged', concern: 'voice', note: voice }
      : { ...base, verdict: 'kept', concern: 'none', note: '' };
  }

  // It does not check out for THIS employer. Does it check out anywhere in the
  // resume? If so the candidate plainly knows the thing, and the only open
  // question is whether they used it in this job. If it appears nowhere, the
  // question is larger and is asked as such.
  const elsewhere = unverified.filter((t) => containsClaim(wholeResume, t));
  const nowhere = unverified.filter((t) => !containsClaim(wholeResume, t));

  if (nowhere.length > 0) {
    return {
      ...base,
      verdict: 'flagged',
      concern: 'not-in-resume',
      unverified: nowhere,
      note: withVoice(
        `${quoted(nowhere)} ${isAre(nowhere)} nowhere in your resume`,
        voice,
      ),
      question: `Your resume never mentions ${nowhere.join(', ')}. Take this line out unless it is true.`,
    };
  }

  return {
    ...base,
    verdict: 'flagged',
    concern: 'other-employer',
    unverified: elsewhere,
    note: withVoice(`your resume shows ${quoted(elsewhere)}, but not at this job`, voice),
    question: `Did you use ${elsewhere.join(', ')} at ${'this employer'}? Take this line out if you did not.`,
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
function checkWhole(
  text: string,
  wholeResume: string,
  why: string,
  original = '',
): CheckedLine {
  const t = text.trim();
  const base: Omit<CheckedLine, 'verdict' | 'note' | 'concern'> = {
    text: t,
    original,
    unverified: [],
    why,
  };

  if (!t) return { ...base, verdict: 'kept', concern: 'none', note: '' };

  const voice = voiceNoteUnlessTheirs(wholeResume, t);
  const unverified = supportedBy(wholeResume, t);

  if (unverified.length === 0) {
    return voice
      ? { ...base, verdict: 'flagged', concern: 'voice', note: voice }
      : { ...base, verdict: 'kept', concern: 'none', note: '' };
  }

  return {
    ...base,
    verdict: 'flagged',
    concern: 'not-in-resume',
    unverified,
    note: withVoice(
      `${quoted(unverified)} ${isAre(unverified)} not in your resume`,
      voice,
    ),
    question: `Is it true that you ${unverified.join(', ')}?`,
  };
}

/**
 * A whole rewritten resume, checked.
 *
 * Every company the model wrote is matched back to a company in the parsed
 * resume. One that matches nothing is KEPT and marked — see `CheckedCompany.inResume`.
 */
export function checkRewrite(answer: RewriteAnswer, resumeText: string): CheckedRewrite {
  const shape: ResumeShape = readShape(resumeText);
  const whole = resumeText;

  const summary = checkWhole(
    answer.summary,
    whole,
    answer.summaryWhy,
    shape.summary.join(' '),
  );
  // Matched to the original skills line by its label ("Cloud Technologies: ..."),
  // so reordering a category can be reverted to the order it was in.
  const skills = answer.skills.map((line) => {
    const label = line.split(':')[0] ?? '';
    const before = shape.skills.find((o) => o.split(':')[0] === label) ?? '';
    return checkWhole(line, whole, 'ordered for this posting', before);
  });

  const companies: CheckedCompany[] = [];

  for (const rc of answer.companies) {
    const source = shape.companies.find(
      (c) =>
        normalise(c.name) === normalise(rc.company) ||
        normalise(c.header).includes(normalise(rc.company)) ||
        normalise(rc.company).includes(normalise(c.name)),
    );

    if (!source) {
      // Shown, not deleted. Every line under it carries the same concern, because
      // the problem is not the sentence — it is the header above it.
      companies.push({
        company: rc.company,
        role: rc.role.trim(),
        header: rc.header.trim() || rc.company,
        inResume: false,
        lines: rc.bullets.map((b) => ({
          text: b.text.trim(),
          original: (b.from[0] ?? '').trim(),
          verdict: 'flagged' as LineVerdict,
          concern: 'no-employer' as Concern,
          unverified: [],
          why: b.why,
          note: `"${rc.company}" is not an employer in your resume`,
          question: `Your resume does not list ${rc.company}. Take this out unless you meant to add that job.`,
        })),
      });
      continue;
    }

    const evidence = evidenceFor(source);
    companies.push({
      company: source.name,
      role: rc.role.trim() || source.role,
      header: source.header,
      inResume: true,
      lines: rc.bullets.map((b) => {
        const checked = checkBullet(b, evidence, whole);
        return checked.question
          ? { ...checked, question: checked.question.replace('this employer', source.name) }
          : checked;
      }),
    });
  }

  // Empty lines are neither kept nor flagged: there is nothing in them to judge
  // and counting them would inflate both numbers.
  const all = [summary, ...skills, ...companies.flatMap((c) => c.lines)].filter((l) => l.text);
  const count = (v: LineVerdict) => all.filter((l) => l.verdict === v).length;

  // Uniformity is a property of a SET of bullets, so it is measured per employer
  // across all of them rather than on any one line.
  const voice: string[] = [];
  for (const c of companies) {
    const u = uniformity(c.lines.map((l) => l.text).filter(Boolean));
    if (u) voice.push(`${c.company}: ${u}`);
  }

  const requirements = checkRequirements(answer.requirements, whole);

  return {
    summary,
    skills,
    companies,
    // Only what the MODEL said it left out. The checker contributes nothing here
    // any more, because the checker no longer leaves anything out.
    dropped: [...answer.dropped],
    requirements,
    tally: tally(requirements),
    kept: count('kept'),
    flagged: count('flagged'),
    voice,
  };
}

/**
 * The finished document, as text.
 *
 * EVERYTHING THE MODEL WROTE, MINUS WHAT THE PERSON TOOK OUT.
 *
 * This used to be the other way round: a line the checker could not verify was
 * out of the document until somebody clicked to put it in. That reads as caution
 * and is really a second deletion — it hands back a gutted CV and calls the
 * missing parts optional extras.
 *
 * So the default is inclusion and the control is subtraction. `removed` holds the
 * lines the person has taken out, by their exact text. Every flagged line is
 * marked on screen and in the sheet, and the count travels with the download
 * button, so this is loud rather than silent — but the decision is theirs.
 */
export function assembleRewrite(
  checked: CheckedRewrite,
  shape: ResumeShape,
  removed: ReadonlySet<string> = new Set(),
  reverted: ReadonlySet<string> = new Set(),
): string {
  const out: string[] = [];
  const take = (l: CheckedLine) => !removed.has(l.text);
  // A reverted line goes back to the person's own words. Reverting a line with
  // no original removes it, which is the only honest reading of "undo" for a
  // sentence that replaced nothing.
  const wordsFor = (l: CheckedLine) => (reverted.has(l.text) ? l.original : l.text);

  if (shape.name) out.push(shape.name);
  for (const c of shape.contact) out.push(c);
  out.push('');

  if (take(checked.summary) && wordsFor(checked.summary)) {
    out.push(wordsFor(checked.summary), '');
  }

  const skills = checked.skills.filter(take).map(wordsFor).filter(Boolean);
  if (skills.length > 0) {
    out.push('TECHNICAL SKILLS');
    out.push(...skills);
    out.push('');
  }

  if (checked.companies.length > 0) {
    out.push('PROFESSIONAL EXPERIENCE');
    for (const c of checked.companies) {
      const lines = c.lines.filter(take).map(wordsFor).filter(Boolean);
      if (lines.length === 0) continue;
      out.push(c.header);
      if (c.role) out.push(c.role);
      for (const l of lines) out.push(`· ${l}`);
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
