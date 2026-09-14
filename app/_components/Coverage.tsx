'use client';

import {
  describeTally,
  orderForReading,
  type Answer,
  type Requirement,
  type Tally,
} from '../../src/tailor/coverage.js';

/**
 * What the posting asks for, and the honest answer for each.
 *
 * WHAT THIS REPLACED
 *
 * A list whose first eleven rows read NOT FOUND, two of which were not skills
 * ("Hybrid work in Boston, MA", "US Citizenship or Green Card Holder status") and
 * several of which were wrong: OpenTofu marked missing against a resume listing
 * Terraform, when OpenTofu is a fork of Terraform and the posting itself said
 * "Terraform or OpenTofu"; Datadog missing against Splunk and AppInsights; Linux
 * fundamentals missing from somebody running Docker and Kubernetes.
 *
 * Eleven red rows telling a competent engineer they have nothing is both wrong
 * and useless.
 *
 * THREE CHANGES, ALL VISIBLE HERE
 *
 *   YOU HAVE THE EQUIVALENT is its own answer, and it names what you have. This
 *   is the row that changes what somebody does: "they want Datadog, you have
 *   Splunk and AppInsights" is worth putting in a covering letter, and "NOT
 *   FOUND" is worth nothing.
 *
 *   ELIGIBILITY IS SEPARATE. Work authorisation and location are facts about a
 *   person, not gaps in a CV, and listing them among missing skills is nonsense.
 *
 *   MUST-HAVES AND NICE-TO-HAVES ARE SPLIT, worst first inside each. A gap is the
 *   most useful line on the page and it goes at the top; a nice-to-have gap is
 *   not worth the same alarm.
 */

const LABEL: Record<Answer, string> = {
  shown: 'you show this',
  partial: 'listed only',
  adjacent: 'equivalent',
  missing: 'missing',
  unclear: 'unclear',
};

export function Coverage({
  requirements,
  tally,
}: {
  requirements: Requirement[];
  tally: Tally;
}) {
  if (requirements.length === 0) return null;
  const skills = orderForReading(requirements).filter((r) => r.need !== 'eligibility');

  return (
    <section className="cov">
      <p className="covhead">{describeTally(tally)}</p>

      <div className="covlist">
        {skills.map((r, i) => (
          <details key={i} className={`covrow ${r.answer}`}>
            <summary>
              <span className={`covtag ${r.answer}`}>{LABEL[r.answer]}</span>
              <span className="covname">{r.name}</span>
              {r.need === 'nice' && <span className="covneed">nice to have</span>}
            </summary>
            <div className="covbody">
              {/* The line that makes this list worth reading. */}
              {r.answer === 'adjacent' && r.insteadYouHave && (
                <p className="covinstead">
                  <strong>You have</strong> {r.insteadYouHave}
                </p>
              )}
              {r.fromPosting && (
                <p className="covquote">
                  <span className="covlabel">They ask</span> “{r.fromPosting}”
                </p>
              )}
              {r.fromResume && (
                <p className="covquote">
                  <span className="covlabel">You wrote</span> “{r.fromResume}”
                </p>
              )}
              {/* Shown only when the checker disagreed with the model, which is
                  exactly when the reader most needs to know. */}
              {r.note && <p className="covnote">⚠ {r.note}</p>}
              {r.advice && <p className="covadvice">{r.advice}</p>}
            </div>
          </details>
        ))}
      </div>

      {tally.eligibility.length > 0 && (
        <div className="covelig">
          <strong>Also asked for, which is not about your CV</strong>
          {tally.eligibility.map((r, i) => (
            <p key={i}>
              {r.name}
              {r.fromPosting && <span className="covlabel"> — “{r.fromPosting}”</span>}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
