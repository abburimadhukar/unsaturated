import Link from 'next/link';

import { AfterApplyWorkspace } from '../_components/AfterApplyWorkspace.js';
import { researchLanes } from '../../src/after-apply/research.js';
import { loadJobForTailoring } from '../../src/tailor/job-lookup.js';

export const dynamic = 'force-dynamic';

export default async function AfterApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string }>;
}) {
  const { job: key } = await searchParams;
  const validKey = key && key.length <= 200 && /^[a-z]+:[^:]+:.+$/i.test(key);
  const found = validKey ? await loadJobForTailoring(key) : null;
  if (!found?.ok) {
    return (
      <main className="aapage">
        <Link href="/">← Back to jobs</Link>
        <h1>After applying</h1>
        <p>{found && !found.ok
          ? found.found ? 'Could not load this job right now. Please try again.' : found.reason
          : 'Choose a job from the feed to start.'}</p>
      </main>
    );
  }

  return <AfterApplyWorkspace
    job={{
      key: found.job.key,
      title: found.job.title,
      company: found.job.company,
      applyUrl: found.job.apply_url,
      closed: Boolean(found.job.closed_at),
    }}
    lanes={researchLanes(found.job.company, found.job.title)}
    scanConfigured={Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim())}
  />;
}
