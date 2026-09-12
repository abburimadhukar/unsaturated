import { NextResponse } from 'next/server';

import { dbWrite } from '../../../src/db/supabase.js';
import { attachSession } from '../../../src/state/auth.js';
import { attachVisitor, subjectFor } from '../../../src/state/identity.js';
import { getResumeText } from '../../../src/state/store.js';
import { describeJob } from '../../../src/tailor/jd.js';
import { CHIPS } from '../../../src/tailor/prompts.js';
import { PER_WINDOW, sharedLimiter } from '../../../src/tailor/rate-limit.js';
import { tailor } from '../../../src/tailor/run.js';

/**
 * Tailoring one resume against one posting.
 *
 * TIED TO AN ACCOUNT, AND THE GATE IS ALREADY THERE
 *
 * `subjectFor` returns a session only when `resolveSession` succeeded, and
 * `resolveSession` returns null unless `hasSeat` is true. So a non-null session
 * means a signed-in holder of one of the four seats — exactly the requirement —
 * and an anonymous cookie cannot reach this however it is called.
 *
 * That matters more here than anywhere else on the site. Every request spends
 * money at OpenAI and reads a named person's CV, and neither belongs behind a
 * cookie anyone can mint by visiting.
 *
 * WHY THE DESCRIPTION IS FETCHED ON EVERY CALL
 *
 * There is no description column, by design. The posting is fetched from the
 * vendor at the moment somebody asks. That is one extra request, and it buys
 * something worth having: the text is whatever the employer has published *now*,
 * so a posting edited or withdrawn since the crawl is tailored against reality
 * rather than against a stale copy.
 *
 * NOTHING HERE IS CACHED BETWEEN CALLS
 *
 * Tempting, and wrong for now. An edit set depends on the CV, the posting, the
 * chips and the custom instruction; a cache keyed on all four would almost never
 * hit, and one keyed on fewer would hand somebody edits for a resume they have
 * since changed. The rate limit below is what protects the bill instead.
 */

export const dynamic = 'force-dynamic';

/** The longest CV accepted, matching the cap POST /api/profile already applies. */
const MAX_RESUME_CHARS = 50_000;

/**
 * The longest description sent to the model.
 *
 * A median posting is ~8,260 characters. Some enterprise adverts run to 40,000
 * with benefits, legal text and diversity statements, none of which help and all
 * of which are paid for by the token. Trimmed from the end, because the
 * requirements are near the top and the boilerplate is not.
 */
const MAX_JD_CHARS = 12_000;

/**
 * How much of the description is sent back to the page.
 *
 * Less than is sent to the model. It is already fetched, so returning it costs
 * nothing, and keeping the posting beside the resume is the thing that makes
 * tailoring possible to judge — the whole reason every tool in this space puts
 * them side by side. Capped lower than MAX_JD_CHARS because a person scrolling a
 * 12,000-character advert in a side panel is not reading it.
 */
const MAX_JD_SHOWN = 6_000;

interface JobRow {
  title: string;
  provider: string;
  board_token: string;
}

/**
 * The posting's title, and the board address needed to read it.
 *
 * Two reads rather than a join: `jobs` is keyed by `key` and `boards` by
 * (provider, token, site), and a job key carries no site — so there is no single
 * condition that joins them correctly. Asking separately and taking the board
 * that has an address is honest about that, where a join on (provider, token)
 * would silently pick one of an employer's several Workday portals.
 */
async function loadJob(
  jobKey: string,
): Promise<{ job: JobRow; extra: Record<string, string> | undefined } | null> {
  const client = dbWrite();
  const { data: job, error } = await client
    .from('jobs')
    .select('title,provider,board_token')
    .eq('key', jobKey)
    .maybeSingle();
  if (error || !job) return null;
  const row = job as JobRow;

  // Only Workday needs an address, and only Workday has more than one board per
  // token, so this is the single case worth the extra read.
  if (row.provider !== 'workday') return { job: row, extra: undefined };

  const { data: boards } = await client
    .from('boards')
    .select('extra')
    .eq('provider', row.provider)
    .eq('token', row.board_token);

  for (const b of (boards ?? []) as { extra: Record<string, string> | null }[]) {
    if (b.extra?.host && b.extra?.site) return { job: row, extra: b.extra };
  }
  return { job: row, extra: undefined };
}

const bad = (message: string, status: number) => NextResponse.json({ error: message }, { status });

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);

  // The gate. See the header: a session exists only for a seat holder.
  if (!session) {
    return bad('sign in to tailor your resume', 401);
  }

  let body: { jobKey?: unknown; chips?: unknown; custom?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad('body must be JSON', 400);
  }

  const jobKey = typeof body.jobKey === 'string' ? body.jobKey.trim() : '';
  if (!jobKey) return bad('which job?', 400);

  // Only ids this build knows. An unknown chip is dropped rather than passed to
  // the model, and buildMessages reports which ones landed so the UI can show
  // what was actually applied.
  const known = new Set(CHIPS.map((c) => c.id));
  const chips = Array.isArray(body.chips)
    ? body.chips.filter((c): c is string => typeof c === 'string' && known.has(c)).slice(0, CHIPS.length)
    : [];
  const custom = typeof body.custom === 'string' ? body.custom : null;

  // Before any paid work, and keyed to the seat holder rather than the cookie —
  // see src/tailor/rate-limit.ts for what this does and does not guarantee.
  if (!sharedLimiter().allow(visitor.id)) {
    return NextResponse.json(
      { error: `that is more than ${PER_WINDOW} in a minute — give it a moment`, retryable: true },
      { status: 429 },
    );
  }

  // The CV first, because it is the cheap check and the commonest reason this
  // cannot proceed: nobody's text is stored until they save their resume once
  // more after the column was added.
  const resumeText = (await getResumeText(visitor.id)).slice(0, MAX_RESUME_CHARS);
  if (!resumeText.trim()) {
    return NextResponse.json(
      {
        error: 'add your resume on your account page first, then come back',
        needsResume: true,
      },
      { status: 409 },
    );
  }

  const found = await loadJob(jobKey);
  if (!found) return bad('we no longer have that job', 404);

  const described = await describeJob(
    { key: jobKey, title: found.job.title },
    { extra: found.extra },
  );
  if (!described.ok) {
    // 422 and not 500: the request was fine, the posting simply has no readable
    // description. `retryable` lets the page decide between "try again" and
    // hiding the button for this vendor entirely.
    return NextResponse.json(
      { error: described.reason, retryable: described.retryable, noDescription: true },
      { status: 422 },
    );
  }

  const result = await tailor({
    resumeText,
    jobTitle: found.job.title,
    jobDescription: described.text.slice(0, MAX_JD_CHARS),
    chips,
    custom,
  });

  const res = NextResponse.json({
    // Verified, always — tailor() exposes no path to an unchecked edit.
    edits: result.edits,
    gaps: result.gaps,
    accepted: result.accepted,
    flagged: result.flagged,
    rejected: result.rejected,
    applied: result.used.map((c) => c.id),
    note: result.note,
    model: result.model,
    // So the UI can say where the text came from rather than implying it was
    // stored.
    via: described.via,
    // The posting itself, so the page can show it beside the resume. Not stored
    // anywhere — this is the copy that was just read from the employer.
    jobDescription: described.text.slice(0, MAX_JD_SHOWN),
    jobDescriptionTruncated: described.text.length > MAX_JD_SHOWN,
    // Told plainly rather than logged, because the only fix is a person changing
    // a key or topping up an account.
    needsAttention: result.needsAttention,
  });
  return attachSession(attachVisitor(res, visitor), session);
}
