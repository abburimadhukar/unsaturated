'use client';

import { FULL_PICK, labelOf, mergeSkillLine } from '../../src/tailor/additions.js';
import { normalise } from '../../src/tailor/edits.js';
import type {
  FullAnswer,
  RolesAnswer,
  SkillSuggestion,
  SkillsAnswer,
  SummaryAnswer,
} from '../../src/tailor/suggest.js';

/**
 * What the model suggested, one item at a time, with a tick beside each.
 *
 * THE ONE THING THIS SCREEN MUST GET RIGHT
 *
 * Every suggestion here is, by construction, something the resume does not say.
 * That is what was asked for — the two questions are "which skills are missing"
 * and "write responsibilities covering them" — and it means none of it can be
 * verified against the CV. A check would reject all of it.
 *
 * So the check is the person, and the screen has to make that unmistakable
 * WITHOUT nagging. One sentence at the top, said plainly and once: these describe
 * work you may have done and not written down, and you are the only one who knows.
 * Then a tick box, and nothing in the document until it is ticked.
 *
 * Not a warning banner, not a confirmation dialogue, not a red border on every
 * row. Somebody who is told six times stops reading the seventh, and this only
 * works if they read it.
 */

export function SkillSuggestions({
  answer,
  picked,
  onPick,
}: {
  answer: SkillsAnswer;
  picked: Set<string>;
  onPick: (key: string) => void;
}) {
  if (answer.skills.length === 0) {
    return (
      <p className="sugempty">
        Nothing missing — every skill this posting asks for is already somewhere in your resume.
      </p>
    );
  }

  // Grouped by the line each skill would join, rather than listed flat.
  //
  // Seven skills as seven rows, each repeating a whole rewritten skills line, is
  // a wall — and it hides the thing that matters, which is that three of them are
  // going to the SAME line. Grouped, the person reads one heading and three
  // names, and sees the finished line once underneath.
  const groups: { label: string; into: string; items: SkillSuggestion[] }[] = [];
  for (const s of answer.skills) {
    const into = s.intoLine.trim();
    const label = into ? labelOf(into) : labelOf(s.newLine) || 'New line';
    const key = normalise(into || label);
    const found = groups.find((g) => normalise(g.into || g.label) === key);
    if (found) found.items.push(s);
    else groups.push({ label, into, items: [s] });
  }

  return (
    <div className="suglist">
      {groups.map((g, i) => {
        const chosen = g.items
          .filter((s) => picked.has(s.skill))
          .map((s) => ({ skill: s.skill, intoLine: s.intoLine, newLine: s.newLine }));
        // The same merge the document does, so the preview cannot disagree with
        // what actually lands.
        const preview = mergeSkillLine(chosen, g.into);
        return (
          <div className="suggroup" key={i}>
            <p className="sugcohead">
              {g.label}
              {!g.into && <span className="sugnew"> new line</span>}
            </p>

            {g.items.map((s, j) => {
              const on = picked.has(s.skill);
              return (
                <label className={`sugrow${on ? ' on' : ''}`} key={j}>
                  <input type="checkbox" checked={on} onChange={() => onPick(s.skill)} />
                  <span className="sugbody">
                    <span className="sugtitle">{s.skill}</span>
                    {s.fromPosting && (
                      <span className="sugquote">
                        <span className="suglabel">They ask</span> “{s.fromPosting}”
                      </span>
                    )}
                    {s.why && <span className="sugwhy">{s.why}</span>}
                  </span>
                </label>
              );
            })}

            {/* Shown once per group and only once something is ticked: the line
                as it will actually read. "Add Datadog to your skills" is an
                instruction; this is the result. */}
            {preview && (
              <p className="sugline">
                <span className="suglabel">Becomes</span>
                {preview}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RoleSuggestions({
  answer,
  picked,
  onPick,
}: {
  answer: RolesAnswer;
  picked: Set<string>;
  onPick: (key: string) => void;
}) {
  if (answer.companies.length === 0) {
    return <p className="sugempty">No suggestions came back for this posting.</p>;
  }

  return (
    <div className="suglist">
      {answer.companies.map((c, i) => (
        <div className="sugco" key={i}>
          <p className="sugcohead">{c.company}</p>
          {c.bullets.map((b, j) => {
            const on = picked.has(b.text);
            return (
              <label className={`sugrow${on ? ' on' : ''}`} key={j}>
                <input type="checkbox" checked={on} onChange={() => onPick(b.text)} />
                <span className="sugbody">
                  <span className="sugtitle">{b.text}</span>
                  <span className="sugmeta">
                    {b.skill && <span className="sugskill">{b.skill}</span>}
                    {b.why && <span className="sugwhy">{b.why}</span>}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Three lightly edited summaries, and the one they already have.
 *
 * Mutually exclusive, because they are three versions of one paragraph. The
 * original is shown first and is always an option — "keep mine" has to be as
 * easy to choose as the alternatives, or the screen is only offering to change
 * something.
 */
export function SummaryOptions({
  answer,
  picked,
  onPickOne,
}: {
  answer: SummaryAnswer;
  picked: Set<string>;
  onPickOne: (key: string, among: readonly string[]) => void;
}) {
  const keys = answer.options.map((o) => o.text);

  if (answer.options.length === 0) {
    return (
      <p className="sugempty">
        Your summary already reads for this posting — nothing here was worth changing.
      </p>
    );
  }

  return (
    <div className="suglist">
      {answer.original && (
        <div className="sugrow flat">
          <span className="sugbody">
            <span className="suglabel">Yours now</span>
            <span className="sugtitle">{answer.original}</span>
          </span>
        </div>
      )}
      {answer.options.map((o, i) => {
        const on = picked.has(o.text);
        return (
          <label className={`sugrow${on ? ' on' : ''}`} key={i}>
            <input type="checkbox" checked={on} onChange={() => onPickOne(o.text, keys)} />
            <span className="sugbody">
              <span className="sugtitle">{o.text}</span>
              {/* What it actually altered, in the model's own words, so the two
                  paragraphs can be checked against a claim rather than compared
                  word by word by eye. */}
              {o.changed && (
                <span className="sugquote">
                  <span className="suglabel">Changed</span>
                  {o.changed}
                </span>
              )}
              {o.why && <span className="sugwhy">{o.why}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * The whole resume, rewritten. One tick, and it becomes the document on the right.
 *
 * Not a list of things to accept — it is a document, and the only honest way to
 * judge a document is to read it. So this is a short summary of what changed and
 * a single choice, and the reading happens in the Compare view where the two
 * resumes sit side by side.
 */
export function FullRewrite({
  answer,
  original,
  picked,
  onPick,
}: {
  answer: FullAnswer;
  /** The resume as it stands, for the counts. */
  original: { skills: string[]; companies: { bullets: string[] }[] };
  picked: Set<string>;
  onPick: (key: string) => void;
}) {
  const on = picked.has(FULL_PICK);
  const was = original.companies.reduce((n, c) => n + c.bullets.length, 0);
  const now = answer.companies.reduce((n, c) => n + c.bullets.length, 0);

  return (
    <div className="suglist">
      <label className={`sugrow${on ? ' on' : ''}`}>
        <input type="checkbox" checked={on} onChange={() => onPick(FULL_PICK)} />
        <span className="sugbody">
          <span className="sugtitle">Use this rewritten resume</span>
          {answer.approach && <span className="sugwhy">{answer.approach}</span>}
          {/* The arithmetic, because "rewritten for this job" says nothing and
              "28 lines became 19" says what happened to the document. */}
          <span className="sugquote">
            <span className="suglabel">Lines</span>
            {was} → {now} across {answer.companies.length} employer
            {answer.companies.length === 1 ? '' : 's'}
            {original.skills.length > 0 && ` · ${answer.skills.length} skills lines`}
          </span>
          <span className="sugwhy">
            Open <strong>Compare</strong> on the right to read it beside your own before you decide.
          </span>
        </span>
      </label>
    </div>
  );
}
