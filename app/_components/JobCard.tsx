'use client';

/**
 * One job, rendered the way the main feed renders it.
 *
 * Quiet Roles and Institutions are separate pages, not separate products, and
 * they were drifting into a different card the moment the second one existed.
 * This is the shared one, so a change to how a posting reads happens once.
 *
 * The pages differ by ACCENT, not by layout — each sets --accent on a wrapper
 * and every rule here inherits it, because they were all written in terms of
 * the token already.
 */

export interface CardJob {
  key: string;
  title: string;
  company: string;
  /** Which ATS the posting came from, shown at the end of the actions row. */
  provider?: string | null;
  location?: string | null;
  remoteType?: string | null;
  seniority?: string | null;
  employmentType?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  ageDays: number | null;
  /** False when the age is measured from when WE first saw it. */
  dated: boolean;
  applyUrl: string | null;
}

function salaryLabel(j: CardJob): string | null {
  const lo = j.salaryMin ?? null;
  const hi = j.salaryMax ?? null;
  if (lo === null && hi === null) return null;
  const sign = j.salaryCurrency === 'USD' ? '$' : j.salaryCurrency === 'GBP' ? '£' : j.salaryCurrency === 'EUR' ? '€' : '';
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (lo !== null && hi !== null && lo !== hi) return `${sign}${k(lo)}–${sign}${k(hi)}`;
  return `${sign}${k((lo ?? hi) as number)}`;
}

/**
 * "3d", and "seen 3d" when the employer gave us no date.
 *
 * The distinction is not pedantry. Every BambooHR posting arrives undated, and
 * a sample of forty found 33 older than the retention window — the oldest from
 * December 2024. Printing that as a publish date would be inventing one.
 */
function ageLabel(j: CardJob): string {
  if (j.ageDays === null) return 'undated';
  const d = j.ageDays;
  const label = d === 0 ? 'today' : d === 1 ? '1d' : `${d}d`;
  return j.dated ? label : `seen ${label}`;
}

export function JobCard({
  job,
  chips,
  reasons,
  score,
  backTo,
}: {
  job: CardJob;
  /** Family, sector, specialization — whatever the page wants to say. */
  chips?: React.ReactNode;
  /** Why this posting is on this page. Every line derived, never estimated. */
  reasons?: string[];
  score?: number;
  /**
   * Where "After applying" should send you back to.
   *
   * Without it that page's back link is always the main feed, so researching an
   * employer from Quiet Roles quietly moved you to a different page and lost
   * the filters you had set. The value is checked against a fixed list on the
   * way out — see BACK_TO — rather than trusted as a URL.
   */
  backTo?: string;
}) {
  const pay = salaryLabel(job);
  const fresh = job.ageDays !== null && job.dated && job.ageDays <= 2;

  return (
    <article className="job">
      <div className="body">
        <div className="jobhead">
          <div className="title">
            {job.applyUrl ? (
              <a href={job.applyUrl} target="_blank" rel="noopener noreferrer">
                {job.title}
              </a>
            ) : (
              job.title
            )}
          </div>
          {score !== undefined && (
            <span className="qscore tnum" title="How quiet this looks, from what we know">
              {score}
            </span>
          )}
        </div>

        <p className="meta">
          <span className="co">{job.company}</span>
          {job.location && (
            <>
              <span className="sep">·</span>
              {job.location}
            </>
          )}
          <span className="sep">·</span>
          {ageLabel(job)}
        </p>

        <div className="chips">
          {chips}
          {fresh && <span className="chip fresh">new</span>}
          {pay && <span className="chip pay">{pay}</span>}
          {job.employmentType && <span className="chip">{job.employmentType}</span>}
          {job.seniority && <span className="chip">{job.seniority}</span>}
          {job.remoteType && <span className="chip">{job.remoteType.replace(/_/g, ' ')}</span>}
        </div>

        {reasons && reasons.length > 0 && (
          <ul className="why">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}

        {/*
          The same actions row the main feed has, and it exists here because
          Quiet Roles and Institutions had no way through to After applying at
          all — the feature was reachable only from the feed, so the two pages
          that surface the LEAST contested roles were the two you could not
          research an employer from.

          Written in the same order and the same class names as the feed's,
          which is what makes them one product rather than three: `.actions`
          styles links with var(--accent), so the row comes out teal on Quiet
          Roles and blue on Institutions without a rule of its own.
        */}
        <div className="actions">
          {job.applyUrl && (
            <a href={job.applyUrl} target="_blank" rel="noopener noreferrer">
              Open posting ↗
            </a>
          )}
          <a
            href={
              `/after-apply?job=${encodeURIComponent(job.key)}` +
              (backTo ? `&from=${encodeURIComponent(backTo)}` : '')
            }
          >
            After applying
          </a>
          {job.provider && <span className="src">{job.provider}</span>}
        </div>
      </div>
    </article>
  );
}
