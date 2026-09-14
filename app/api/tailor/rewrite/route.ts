import { NextResponse } from 'next/server';

import { attachSession } from '../../../../src/state/auth.js';
import { attachVisitor, subjectFor } from '../../../../src/state/identity.js';
import { getResumeText } from '../../../../src/state/store.js';
import { loadJobForTailoring } from '../../../../src/tailor/job-lookup.js';
import { describeJob } from '../../../../src/tailor/jd.js';
import { canDescribe } from '../../../../src/tailor/providers.js';
import { PER_WINDOW, sharedLimiter } from '../../../../src/tailor/rate-limit.js';
import { rewriteResume } from '../../../../src/tailor/rewrite-run.js';
import { readShape } from '../../../../src/tailor/sections.js';

/**
 * A whole tailored resume, written and checked.
 *
 * SAME GATES AS ITS SIBLING, IN THE SAME ORDER
 *
 * Seat first, then the rate limit, then the resume, and only then anything that
 * spends money. The order matters: a limiter after the paid call limits nothing,
 * and reading a posting for somebody with no CV on file buys an error message at
 * the cost of a fetch.
 *
 * WHY THE SHAPE COMES BACK TOO
 *
 * The browser assembles the final document from the lines the person confirmed,
 * and the parts it does not rewrite — name, contact, education — come from the
 * parsed resume. Sending the shape means the page can build the document without
 * the CV making a second trip.
 */

export const dynamic = 'force-dynamic';

/** Capped lower than what the model sees: nobody reads a 12,000-character advert in a drawer. */
const MAX_JD_SHOWN = 6_000;
/** What the model sees. Section-aware trimming would be better; this is the honest cap. */
const MAX_JD_CHARS = 18_000;
const MAX_RESUME_CHARS = 20_000;
const MAX_PRESETS = 6;

const bad = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status });

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);
  if (!session) return bad('sign in to tailor your resume', 401);

  let body: { jobKey?: unknown; presets?: unknown; ask?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad('body must be JSON', 400);
  }

  const jobKey = typeof body.jobKey === 'string' ? body.jobKey : '';
  if (!jobKey) return bad('which job?', 400);

  const presets = Array.isArray(body.presets)
    ? body.presets.filter((p: unknown): p is string => typeof p === 'string').slice(0, MAX_PRESETS)
    : [];
  const ask = typeof body.ask === 'string' ? body.ask : null;

  // Before the posting is fetched and before the model is called, because both
  // cost something and a limiter that runs after them limits nothing.
  // The SAME limiter instance as /api/tailor, deliberately. Two counters would
  // mean somebody could spend twice the budget by alternating between the two
  // endpoints, which is the obvious way round a per-endpoint limit.
  if (!sharedLimiter().allow(visitor.id)) {
    return bad(`that is more than ${PER_WINDOW} in a minute — give it a moment`, 429, {
      retryable: true,
    });
  }

  const resumeText = (await getResumeText(visitor.id)).slice(0, MAX_RESUME_CHARS);
  if (!resumeText.trim()) {
    return bad('add your resume on your account page first', 409, { needsResume: true });
  }

  // Shared with /api/tailor, because this was written twice and the second copy
  // asked `jobs` for a column that lives on `boards` — so every job on the site
  // reported "that job is not in the feed any more" while its title sat on the
  // screen above the message. See src/tailor/job-lookup.ts.
  const found = await loadJobForTailoring(jobKey);
  if (!found.ok) {
    // A missing row and a broken database are different things and do not share
    // a message. 404 means the posting has gone; 503 means we could not ask.
    return bad(found.reason, found.found ? 503 : 404, found.found ? { retryable: true } : {});
  }
  const job = found.job;

  if (!canDescribe(job.provider)) {
    return bad(
      `${job.provider} does not publish job descriptions anywhere we can read them`,
      422,
      { noDescription: true },
    );
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

  const result = await rewriteResume({
    resumeText,
    jobTitle: job.title,
    company: job.company,
    jobDescription: described.text.slice(0, MAX_JD_CHARS),
    presets,
    ask,
  });

  const res = NextResponse.json({
    rewrite: result.checked,
    // Name, contact and education are not rewritten, so the page needs them to
    // assemble the document it shows and downloads.
    shape: readShape(resumeText),
    used: result.used.map((p) => p.id),
    model: result.model,
    note: result.note,
    needsAttention: result.needsAttention,
    via: described.via,
    jobDescription: described.text.slice(0, MAX_JD_SHOWN),
    jobDescriptionTruncated: described.text.length > MAX_JD_SHOWN,
  });
  return attachSession(attachVisitor(res, visitor), session);
}
