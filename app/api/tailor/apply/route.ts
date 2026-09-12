import { NextResponse } from 'next/server';

import { attachSession } from '../../../../src/state/auth.js';
import { attachVisitor, subjectFor } from '../../../../src/state/identity.js';
import { getResumeText } from '../../../../src/state/store.js';
import { applyEdits } from '../../../../src/tailor/assemble.js';
import type { Edit } from '../../../../src/tailor/edits.js';

/**
 * The whole resume, with the accepted changes in it.
 *
 * WHY THIS IS A SEPARATE REQUEST AND NOT PART OF THE FIRST ONE
 *
 * POST /api/tailor proposes changes and deliberately does not return the CV. The
 * resume text is kept off the Profile the browser receives precisely so it does
 * not travel on every page load.
 *
 * Assembling the document needs it. So it travels HERE, once, when a person has
 * read the suggestions, chosen some, and asked for the result — which is the
 * moment they are asking for their own CV back. That is a different thing from
 * shipping it with the feed.
 *
 * WHY IT IS ASSEMBLED HERE AND NOT IN THE BROWSER
 *
 * The browser does not have the resume, and giving it the resume in order to do
 * the splicing would mean sending it twice and trusting the result. The document
 * is built where the source of truth is.
 *
 * AND WHY EVERY EDIT IS CHECKED AGAIN
 *
 * The edits arrive from a browser, which means they arrive as whatever the browser
 * sent. They were checked when proposed; nothing guarantees these are those. The
 * promise — no number and no tool that is not already in the resume — has to be a
 * property of the document rather than of one request path behaving well, so
 * applyEdits re-verifies and reports what it would not apply. See assemble.ts.
 *
 * NO RATE LIMIT, UNLIKE ITS SIBLING
 *
 * This spends nothing: one narrow database read and some string work. The seat
 * gate already bounds it to four people, and a limiter here would only be able to
 * refuse somebody their own finished document.
 */

export const dynamic = 'force-dynamic';

/** Most edits accepted in one go. MAX_EDITS in run.ts is 12; this is slack. */
const MAX_ACCEPTED = 30;

const bad = (message: string, status: number) => NextResponse.json({ error: message }, { status });

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);
  if (!session) return bad('sign in to tailor your resume', 401);

  let body: { edits?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad('body must be JSON', 400);
  }

  if (!Array.isArray(body.edits) || body.edits.length === 0) {
    return bad('choose at least one change first', 400);
  }

  // Rebuilt field by field rather than trusted as a shape. Anything missing
  // becomes an empty string, which applyEdits refuses — so a malformed edit is
  // reported rather than reaching the splice.
  const edits: Edit[] = body.edits.slice(0, MAX_ACCEPTED).map((e) => {
    const row = (e ?? {}) as Record<string, unknown>;
    return {
      original: typeof row.original === 'string' ? row.original : '',
      replacement: typeof row.replacement === 'string' ? row.replacement : '',
      reason: typeof row.reason === 'string' ? row.reason : '',
    };
  });

  const resumeText = await getResumeText(visitor.id);
  if (!resumeText.trim()) {
    return NextResponse.json(
      { error: 'add your resume on your account page first', needsResume: true },
      { status: 409 },
    );
  }

  const result = applyEdits(resumeText, edits);

  const res = NextResponse.json({
    text: result.text,
    applied: result.applied,
    changed: result.changed,
    // Named individually, because an edit somebody clicked that did not make it
    // into the document is the one thing they must not have to discover by
    // reading the output carefully.
    refused: result.refused.map((r) => ({ original: r.edit.original, why: r.why })),
  });
  return attachSession(attachVisitor(res, visitor), session);
}
