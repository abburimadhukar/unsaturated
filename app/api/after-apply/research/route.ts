import { NextResponse } from 'next/server';

import { attachSession } from '../../../../src/state/auth.js';
import { attachVisitor, subjectFor } from '../../../../src/state/identity.js';
import { createLimiter } from '../../../../src/after-apply/rate-limit.js';
import { researchJob } from '../../../../src/after-apply/research.js';
import { loadJob } from '../../../../src/after-apply/job-lookup.js';

export const dynamic = 'force-dynamic';

// Web research uses the existing billable OpenAI key. This per-isolate guard
// limits accidental repeats; it is not a global billing guarantee.
const LIMITER_KEY = Symbol.for('unsaturated.after-apply.limiter');
function limiter() {
  const global = globalThis as unknown as Record<symbol, ReturnType<typeof createLimiter> | undefined>;
  global[LIMITER_KEY] ??= createLimiter({ perWindow: 3, windowMs: 60_000 });
  return global[LIMITER_KEY]!;
}

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);
  const answer = (body: object, status = 200) =>
    attachSession(attachVisitor(NextResponse.json(body, { status }), visitor), session);

  if (!session) return answer({ error: 'Sign in on your account page to run a public-source scan.' }, 401);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return answer({ error: 'Research is not configured on this server yet.' }, 503);

  let body: { jobKey?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return answer({ error: 'The request must be JSON.' }, 400); }
  const jobKey = typeof body.jobKey === 'string' ? body.jobKey.trim() : '';
  if (!jobKey || jobKey.length > 200 || !/^[a-z]+:[^:]+:.+$/i.test(jobKey)) {
    return answer({ error: 'Choose a valid job from the feed.' }, 400);
  }

  const found = await loadJob(jobKey);
  if (!found.ok) return answer({ error: found.found ? 'Could not load this job right now.' : found.reason }, found.found ? 503 : 404);
  if (!limiter().allow(visitor.id)) return answer({ error: 'Please wait a minute before scanning again.' }, 429);

  try {
    const report = await researchJob({
      company: found.job.company, title: found.job.title, applyUrl: found.job.apply_url,
    }, apiKey);
    if (!report) return answer({ error: 'Could not complete source-backed research right now. Please try later.' }, 502);
    return answer({ report });
  } catch {
    return answer({ error: 'Research timed out or the provider is unavailable. Please try later.' }, 502);
  }
}
