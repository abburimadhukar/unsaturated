import Link from 'next/link';

import { dbWrite } from '../../src/db/supabase.js';
import { canDescribe } from '../../src/tailor/providers.js';
import { TailorPanel } from '../_components/TailorPanel.js';

/**
 * The full-width tailoring workspace.
 *
 * The feed panel is for a quick look while deciding whether a job is worth the
 * effort. This is for doing the work: the same component with room to read a long
 * bullet without it wrapping four times, reached by a link rather than replacing
 * the inline version.
 *
 * A SERVER COMPONENT, SO THE URL IS JUST THE KEY
 *
 * The alternative was passing the title and company through the query string from
 * the feed, which works and makes a URL nobody can share or retype — and one that
 * lies if the employer renames the role. Reading the row here costs one query and
 * keeps `?job=<key>` the whole address.
 *
 * NO AUTH CHECK HERE, AND THAT IS NOT AN OVERSIGHT
 *
 * This page renders a title and a company name, both of which are public on the
 * feed. Everything that touches a resume or spends money happens in POST
 * /api/tailor, which requires a claimed seat. Gating the page as well would add a
 * second place for that rule to be expressed, and two places is how they drift.
 */

export const dynamic = 'force-dynamic';

interface JobRow {
  key: string;
  title: string;
  company: string;
  provider: string;
  apply_url: string | null;
  closed_at: string | null;
}

async function loadJob(key: string): Promise<JobRow | null> {
  try {
    const { data, error } = await dbWrite()
      .from('jobs')
      .select('key,title,company,provider,apply_url,closed_at')
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return null;
    return data as JobRow;
  } catch {
    return null;
  }
}

export default async function TailorPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job: key } = await searchParams;
  const job = key ? await loadJob(key) : null;

  if (!job) {
    return (
      <main className="tailorpage">
        <p className="tmissing">
          That job is not in the feed any more.{' '}
          <Link href="/">Back to the feed</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="tailorpage">
      <nav className="tailornav">
        <Link href="/">← Back to the feed</Link>
        {job.apply_url && (
          <a href={job.apply_url} target="_blank" rel="noopener noreferrer">
            Open the posting ↗
          </a>
        )}
      </nav>

      <h1>{job.title}</h1>
      <p className="tailormeta">
        {job.company}
        {/* Said plainly. Tailoring a CV for a role that has been withdrawn is
            wasted effort, and the feed cannot always know before the fetch does. */}
        {job.closed_at && <span className="tclosed"> · this posting has closed</span>}
      </p>

      {canDescribe(job.provider) ? (
        <TailorPanel jobKey={job.key} jobTitle={job.title} company={job.company} wide />
      ) : (
        <p className="tmissing">
          {job.provider} does not publish job descriptions anywhere we can read
          them, so there is nothing to tailor against for this posting.
        </p>
      )}
    </main>
  );
}
