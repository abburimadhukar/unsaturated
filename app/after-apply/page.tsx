import Link from 'next/link';

import { AfterApplyWorkspace } from '../_components/AfterApplyWorkspace.js';
import { loadJob } from '../../src/after-apply/job-lookup.js';

export const dynamic = 'force-dynamic';

/**
 * Where "← Back to" may point, and the only values accepted.
 *
 * A fixed list rather than a check on the string, because `from` arrives in the
 * URL and lands in an anchor's href. Anything not named here falls back to the
 * feed, so a crafted link cannot turn this page's own navigation into a way off
 * the site.
 */
const BACK_TO: Record<string, { href: string; label: string }> = {
  '/': { href: '/', label: 'jobs' },
  '/quiet': { href: '/quiet', label: 'quiet roles' },
  '/institutions': { href: '/institutions', label: 'institutions' },
};

export default async function AfterApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; from?: string }>;
}) {
  const { job: key, from } = await searchParams;
  const back = (from && BACK_TO[from]) || BACK_TO['/']!;
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
  />;
}
