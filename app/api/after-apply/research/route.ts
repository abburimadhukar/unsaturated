import { NextResponse } from 'next/server';

import { attachSession } from '../../../../src/state/auth.js';
import { attachVisitor, subjectFor } from '../../../../src/state/identity.js';
import { createLimiter } from '../../../../src/tailor/rate-limit.js';
import { searchPublicSources } from '../../../../src/after-apply/research.js';
import { loadJobForTailoring } from '../../../../src/tailor/job-lookup.js';

export const dynamic = 'force-dynamic';

// This is a paid search API. A per-isolate guard limits accidental repeats;
// it is not a global billing guarantee across Cloudflare workers.
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
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return answer({ error: 'Public-source scan is not configured yet. Use the search links below.' }, 503);

  let body: { jobKey?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return answer({ error: 'The request must be JSON.' }, 400); }
  const jobKey = typeof body.jobKey === 'string' ? body.jobKey.trim() : '';
  if (!jobKey || jobKey.length > 200 || !/^[a-z]+:[^:]+:.+$/i.test(jobKey)) {
    return answer({ error: 'Choose a valid job from the feed.' }, 400);
  }

  const found = await loadJobForTailoring(jobKey);
  if (!found.ok) return answer({ error: found.found ? 'Could not load this job right now.' : found.reason }, found.found ? 503 : 404);
  if (!limiter().allow(visitor.id)) return answer({ error: 'Please wait a minute before scanning again.' }, 429);

  const groups = await searchPublicSources(found.job.company, found.job.title, apiKey);
  if (groups.every((group) => group.unavailable)) {
    return answer({ error: 'The search provider is unavailable right now. The public search links still work.' }, 502);
  }
  // Search titles and snippets are only leads. The page asks the user to open
  // the source and verify identity/relevance before writing to anybody.
  return answer({ groups });
}
