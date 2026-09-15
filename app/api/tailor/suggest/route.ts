import { NextResponse } from 'next/server';

import { attachSession } from '../../../../src/state/auth.js';
import { attachVisitor, subjectFor } from '../../../../src/state/identity.js';
import { getResumeText } from '../../../../src/state/store.js';
import { loadJobForTailoring } from '../../../../src/tailor/job-lookup.js';
import { describeJob } from '../../../../src/tailor/jd.js';
import { canDescribe } from '../../../../src/tailor/providers.js';
import { PER_WINDOW, sharedLimiter } from '../../../../src/tailor/rate-limit.js';
import { readShape } from '../../../../src/tailor/sections.js';
import { suggest } from '../../../../src/tailor/suggest-run.js';
import type { SuggestMode } from '../../../../src/tailor/suggest.js';

/**
 * Missing skills, or responsibilities that would cover them.
 *
 * SAME GATES AS ITS SIBLINGS, IN THE SAME ORDER
 *
 * Seat, then the rate limit, then the resume, and only then anything that spends
 * money. The order matters: a limiter after the paid call limits nothing, and
 * reading a posting for somebody with no CV on file buys an error message at the
 * cost of a fetch. The limiter INSTANCE is shared with the other two routes, so
 * three endpoints cannot be alternated to spend three times the budget.
 *
 * WHAT IS NOT HERE
 *
 * A checker. /api/tailor/rewrite hands its answer to checkRewrite before it
 * returns; this route returns what the model said. That is deliberate and is the
 * whole point of the feature — both questions ask for things the resume does not
 * contain, so a check against the resume would reject every useful answer. The
 * person ticks what is true of them. See src/tailor/suggest.ts.
 */

export const dynamic = 'force-dynamic';

const MAX_JD_SHOWN = 6_000;
const MAX_JD_CHARS = 18_000;
/** Matched to the other two routes, which used to disagree with each other. */
const MAX_RESUME_CHARS = 50_000;

const bad = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status });

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);
  if (!session) return bad('sign in to tailor your resume', 401);

  let body: { jobKey?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad('body must be JSON', 400);
  }

  const jobKey = typeof body.jobKey === 'string' ? body.jobKey : '';
  if (!jobKey) return bad('which job?', 400);

  const MODES: SuggestMode[] = ['skills', 'roles', 'summary', 'full'];
  const mode: SuggestMode = MODES.find((m) => m === body.mode) ?? 'skills';

  if (!sharedLimiter().allow(visitor.id)) {
    return bad(`that is more than ${PER_WINDOW} in a minute — give it a moment`, 429, {
      retryable: true,
    });
  }

  const storedResume = await getResumeText(visitor.id);
  const resumeText = storedResume.slice(0, MAX_RESUME_CHARS);
  const resumeCutBy = storedResume.length - resumeText.length;
  if (!resumeText.trim()) {
    return bad('add your resume on your account page first', 409, { needsResume: true });
  }

  const found = await loadJobForTailoring(jobKey);
  if (!found.ok) {
    return bad(found.reason, found.found ? 503 : 404, found.found ? { retryable: true } : {});
  }
  const job = found.job;

  if (!canDescribe(job.provider)) {
    return bad(`${job.provider} does not publish job descriptions anywhere we can read them`, 422, {
      noDescription: true,
    });
  }

  const described = await describeJob(
    { key: job.key, title: job.title },
    found.extra ? { extra: found.extra } : {},
  );
  if (!described.ok) {
    return bad(described.reason, 422, {
      noDescription: true,
      retryable: described.retryable ?? false,
    });
  }

  const result = await suggest(
    {
      resumeText,
      jobTitle: job.title,
      company: job.company,
      jobDescription: described.text.slice(0, MAX_JD_CHARS),
    },
    mode,
  );

  const res = NextResponse.json({
    mode,
    skills: result.skills,
    roles: result.roles,
    summary: result.summary,
    full: result.full,
    // The parsed resume, so the page can build and edit the document without the
    // CV making a second trip — and so these two buttons work for somebody who
    // has not run a rewrite and may not want to.
    // The resume itself, not just the parse of it. The page used to rebuild the
    // document from `shape`, which came back subtly changed when nothing had been
    // changed — doubled bullet markers, renamed headings. A parse is for
    // understanding a resume, not for reproducing it.
    resumeText,
    shape: readShape(resumeText),
    model: result.model,
    note: result.note,
    needsAttention: result.needsAttention,
    resumeCutBy,
    via: described.via,
    jobDescription: described.text.slice(0, MAX_JD_SHOWN),
    jobDescriptionTruncated: described.text.length > MAX_JD_SHOWN,
  });
  return attachSession(attachVisitor(res, visitor), session);
}
