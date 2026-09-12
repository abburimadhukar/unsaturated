import { NextResponse } from 'next/server';

import { dbWrite } from '../../../../src/db/supabase.js';
import { attachSession } from '../../../../src/state/auth.js';
import { subjectFor } from '../../../../src/state/identity.js';
import { getProfile } from '../../../../src/state/store.js';
import { editDocx, type DocxEdit } from '../../../../src/ui/docx-edit.js';

/**
 * The person's own .docx, with the accepted sentences replaced.
 *
 * WHY THE FILE IS EDITED RATHER THAN REBUILT
 *
 * /api/tailor/apply returns the tailored resume as TEXT, and docx.ts can turn text
 * into a clean document. Both lose the layout: somebody who spent an evening on
 * their CV gets a default back.
 *
 * This reads the file they uploaded and changes only the sentences they accepted.
 * Their fonts, spacing, section order, headshot and styles are all in other parts
 * of the archive and are copied across as their original compressed bytes — see
 * src/ui/docx-edit.ts.
 *
 * WHY IT IS SERVER-SIDE
 *
 * The original lives in a private Supabase Storage bucket. The browser has no
 * copy: the upload sent it away and nothing sends it back. Editing here means one
 * request returns a finished file, rather than downloading the original to the
 * browser first and hoping the person does not wonder why.
 *
 * WHY PDF IS NOT ACCEPTED
 *
 * A PDF's text is placed at absolute coordinates with no reflow, and its fonts are
 * usually embedded as subsets containing only the glyphs already used. So a longer
 * replacement overlaps whatever sits beneath it, and a replacement needing a glyph
 * the subset omits cannot be drawn at all. There is no honest way to edit one in
 * place and keep the layout, so this says so rather than producing something that
 * looks almost right.
 */

export const dynamic = 'force-dynamic';

const BUCKET = 'resumes';
const MAX_ACCEPTED = 30;
/** A .docx larger than this is not a resume, and reading it in a Worker is not free. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const bad = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status });

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

  const edits: DocxEdit[] = body.edits.slice(0, MAX_ACCEPTED).map((e) => {
    const row = (e ?? {}) as Record<string, unknown>;
    return {
      original: typeof row.original === 'string' ? row.original : '',
      replacement: typeof row.replacement === 'string' ? row.replacement : '',
    };
  });

  const profile = await getProfile(visitor.id);
  const path = profile.resumePath;

  if (!path) {
    return bad(
      'upload your resume as a file first, and this will edit that file instead of rebuilding it',
      409,
      { needsFile: true },
    );
  }
  if (!path.toLowerCase().endsWith('.docx')) {
    // Named explicitly rather than "unsupported". The person uploaded something,
    // and the useful sentence tells them what to upload instead and why.
    return bad(
      'your resume is a PDF. A PDF places every line at fixed coordinates with no ' +
        'room to reflow, so replacing a sentence with a longer one would overlap what ' +
        'follows it. Upload the .docx and this will edit that, keeping your layout.',
      409,
      { wrongType: true, have: path.split('.').pop() ?? '' },
    );
  }

  const { data, error } = await dbWrite().storage.from(BUCKET).download(path);
  if (error || !data) {
    console.error('resume download failed:', error?.message);
    return bad('could not read your stored resume — try re-uploading it', 503);
  }
  if (data.size > MAX_FILE_BYTES) {
    return bad('that file is too large to edit here', 413);
  }

  let edited: { bytes: Uint8Array; applied: number; missed: DocxEdit[] };
  try {
    edited = await editDocx(new Uint8Array(await data.arrayBuffer()), edits);
  } catch (err) {
    // editDocx throws only for a file that is not a readable .docx, which means
    // the stored file is not what its name says.
    console.error('docx edit failed:', err instanceof Error ? err.message : err);
    return bad(
      'that .docx could not be read — re-save it from Word and upload it again',
      422,
    );
  }

  if (edited.applied === 0) {
    // Worth a distinct answer. The commonest cause is a CV whose stored file is
    // older than the text the suggestions were computed from, and "here is an
    // unchanged file" would be a silent lie.
    return bad(
      'none of those lines could be found in your uploaded file — it may be an older ' +
        'version than the text we have. Re-upload it and try again.',
      422,
      { applied: 0, missed: edited.missed.length },
    );
  }

  const name = (profile.resumeName ?? 'resume.docx').replace(/\.docx$/i, '');
  const res = new NextResponse(edited.bytes as BodyInit, {
    status: 200,
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      // The person's own filename, tailored. They will have several of these.
      'content-disposition': `attachment; filename="${name.replace(/[^\w .-]/g, '')} (tailored).docx"`,
      // How many landed and how many did not, in headers rather than the body,
      // because the body is the file. The page reads these to tell them.
      'x-edits-applied': String(edited.applied),
      'x-edits-missed': String(edited.missed.length),
      'cache-control': 'no-store',
    },
  });
  return attachSession(res, session);
}
