import Link from 'next/link';

import { AfterApplyWorkspace } from '../_components/AfterApplyWorkspace.js';
import { loadJob } from '../../src/after-apply/job-lookup.js';
import { jobLiveness } from '../../src/after-apply/liveness.js';
import { safeBackTo } from '../../src/ui/back-link.js';

export const dynamic = 'force-dynamic';

export default async function AfterApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; from?: string }>;
}) {
  const { job: key, from } = await searchParams;
  // `from` now carries the filters too (e.g. /quiet?family=data), so the back
  // button returns to the exact view — path AND filters — rather than the bare
  // page. safeBackTo validates it before it reaches the href; see back-link.ts.
  const back = safeBackTo(from);
  const validKey = key && key.length <= 200 && /^[a-z]+:[^:]+:.+$/i.test(key);
  const found = validKey ? await loadJob(key) : null;
  if (!found?.ok) {
    return (
      <main className="aapage">
        <Link href={back.href}>← Back to {back.label}</Link>
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
    scanConfigured={Boolean(process.env.OPENAI_API_KEY?.trim())}
    backTo={back}
    liveness={jobLiveness({
      postedAt: found.job.posted_at,
      firstSeenAt: found.job.first_seen_at,
      lastSeenAt: found.job.last_seen_at,
      closedAt: found.job.closed_at,
      ghostRisk: found.job.ghost_risk,
    })}
  />;
}
