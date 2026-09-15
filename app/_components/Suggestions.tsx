'use client';

import type { RolesAnswer, SkillsAnswer } from '../../src/tailor/suggest.js';

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

  return (
    <div className="suglist">
      {answer.skills.map((s, i) => {
        const on = picked.has(s.skill);
        return (
          <label className={`sugrow${on ? ' on' : ''}`} key={i}>
            <input type="checkbox" checked={on} onChange={() => onPick(s.skill)} />
            <span className="sugbody">
              <span className="sugtitle">{s.skill}</span>
              {s.fromPosting && (
                <span className="sugquote">
                  <span className="suglabel">They ask</span> “{s.fromPosting}”
                </span>
              )}
              {/* The line as it will read, because "add Datadog to your skills" is
                  a instruction and this is the actual result. */}
              {s.newLine && (
                <span className="sugline">
                  <span className="suglabel">{s.intoLine ? 'That line becomes' : 'New line'}</span>
                  {s.newLine}
                </span>
              )}
              {s.why && <span className="sugwhy">{s.why}</span>}
            </span>
          </label>
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
