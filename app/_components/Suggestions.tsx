'use client';

import { labelOf, mergeSkillLine } from '../../src/tailor/additions.js';
import { normalise } from '../../src/tailor/edits.js';
import type { RolesAnswer, SkillSuggestion, SkillsAnswer } from '../../src/tailor/suggest.js';

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
