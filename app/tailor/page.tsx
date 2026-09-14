import Link from 'next/link';

import { dbWrite } from '../../src/db/supabase.js';
import { canDescribe } from '../../src/tailor/providers.js';
import { RewriteWorkspace } from '../_components/RewriteWorkspace.js';

/**
 * The full-screen tailoring workspace.
 *
 * The feed panel is for a quick look while deciding whether a job is worth the
 * effort. This is for doing the work, and it takes the whole viewport: the
 * document is sized first, at the measure it will actually be read at, and the
 * changes column takes what is left. See TailorWorkspace for why that order
 * matters.
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

  if (!canDescribe(job.provider)) {
    return (
      <main className="tailorpage">
        <nav className="tailornav">
          <Link href="/">← Back to the feed</Link>
        </nav>
        <h1>{job.title}</h1>
        <p className="tailormeta">{job.company}</p>
        <p className="tmissing">
          {job.provider} does not publish job descriptions anywhere we can read
          them, so there is nothing to tailor against for this posting.
        </p>
      </main>
    );
  }

  // No <main className="tailorpage"> around it: the workspace is a fixed-height
  // shell with its own header, two scrolling panes and an action bar. Wrapping it
  // in the centred, padded page container is what produced the 350px document in
  // the first place.
  return (
    <RewriteWorkspace
      jobKey={job.key}
      jobTitle={job.title}
      company={job.company}
      applyUrl={job.apply_url}
      closed={Boolean(job.closed_at)}
    />
  );
}
