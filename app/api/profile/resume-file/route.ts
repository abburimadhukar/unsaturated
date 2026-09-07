import { NextResponse } from 'next/server';
import { dbWrite, canWrite } from '../../../../src/db/supabase.js';
import { attachVisitor, subjectFor } from '../../../../src/state/identity.js';
import { attachSession } from '../../../../src/state/auth.js';
import { setResumeFile, clearResumeFile } from '../../../../src/state/store.js';

/**
 * The resume file itself.
 *
 * Separate from /api/profile, which takes TEXT. The two are saved together when
 * someone uploads, but they are different things and one must never overwrite
 * the other: replacing a file keeps the skills already extracted, and pasting
 * text keeps the file already stored.
 *
 * Only for signed-in people. An anonymous visitor is a cookie, and a cookie can
 * be cleared — storing someone's CV against one means a file nobody can ever
 * reach again and nobody can ask us to delete.
 */
export const dynamic = 'force-dynamic';

const BUCKET = 'resumes';
const MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
};

/**
 * The stored path for a person's resume.
 *
 * One file per account, named by the account. The uploaded filename is kept as
 * a label in the database but never used as a path — a name arriving from a
 * browser is not something to build a storage key out of.
 */
function pathFor(userId: string, ext: string): string {
  return `${userId.replace(/[^A-Za-z0-9:_-]/g, '_')}/resume.${ext}`;
}

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);
  if (!session?.user) {
    return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  }
  if (!canWrite()) {
    return NextResponse.json(
      { error: 'file storage is not configured here' },
      { status: 503 },
    );
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get('file');
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: 'send the file as multipart form data' }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: 'no file received' }, { status: 400 });

  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!ALLOWED[ext]) {
    return NextResponse.json(
      { error: `only ${Object.keys(ALLOWED).join(', ')} files are accepted` },
      { status: 400 },
    );
  }
  // Checked here as well as in the browser: the browser check is a courtesy to
  // the person, this one is the actual limit.
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'that file is over 5 MB' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'that file is empty' }, { status: 400 });
  }

  const path = pathFor(visitor.id, ext);

  // Read BEFORE the upload, so a failure afterwards can tell whether this
  // object is one nothing points at yet. See the catch below.
  const { getProfile } = await import('../../../../src/state/store.js');
  const previous = await getProfile(visitor.id).catch(() => null);

  const { error } = await dbWrite()
    .storage.from(BUCKET)
    .upload(path, await file.arrayBuffer(), {
      contentType: ALLOWED[ext],
      // One resume per person: a new upload replaces the old rather than
      // accumulating files nobody will ever look at again.
      upsert: true,
    });

  if (error) {
    console.error('resume upload failed:', error.message);
    const missing = /bucket not found/i.test(error.message);
    return NextResponse.json(
      {
        error: missing
          ? 'File storage is not set up yet — the resumes bucket has not been created.'
          : 'Could not store that file — try again.',
      },
      { status: 503 },
    );
  }

  try {
    const profile = await setResumeFile(visitor.id, {
      name: file.name.slice(0, 200),
      size: file.size,
      path,
    });
    const res = NextResponse.json({ profile });
    res.headers.set('cache-control', 'private, no-store');
    return attachSession(attachVisitor(res, visitor), session);
  } catch (err) {
    console.error('resume file record failed:', err);
    // The file is in storage and nothing in the database points at it. Nobody
    // can see it, nobody can download it, and nobody can ask us to delete it —
    // so it does not get to stay. Someone's CV is not litter to leave lying in
    // a bucket.
    //
    // Only when this path is not already spoken for. Uploading a replacement
    // with the same extension overwrites the old object at the same key, and
    // the existing row still points there; removing it then would destroy a
    // file the person can still see listed.
    if (previous?.resumePath !== path) {
      const { error: rmErr } = await dbWrite().storage.from(BUCKET).remove([path]);
      if (rmErr) console.error('could not clean up the orphan:', path, rmErr.message);
    }
    return NextResponse.json({ error: 'could not save that file — try again' }, { status: 503 });
  }
}

/**
 * Hands back the person's own file.
 *
 * A signed URL rather than the bytes: the bucket is private, and streaming a
 * file through a Worker to save the browser one redirect spends CPU budget for
 * nothing. Short-lived, because the link is followed immediately.
 */
export async function GET(request: Request) {
  const { visitor, session } = await subjectFor(request);
  if (!session?.user) {
    return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  }
  if (!canWrite()) {
    return NextResponse.json({ error: 'file storage is not configured here' }, { status: 503 });
  }

  const { getProfile } = await import('../../../../src/state/store.js');
  const profile = await getProfile(visitor.id);
  if (!profile.resumePath) {
    return NextResponse.json({ error: 'no file stored' }, { status: 404 });
  }

  const { data, error } = await dbWrite()
    .storage.from(BUCKET)
    .createSignedUrl(profile.resumePath, 60);
  if (error || !data?.signedUrl) {
    console.error('signed url failed:', error?.message);
    return NextResponse.json({ error: 'could not open that file' }, { status: 503 });
  }

  const res = NextResponse.json({ url: data.signedUrl, name: profile.resumeName });
  res.headers.set('cache-control', 'private, no-store');
  return attachSession(attachVisitor(res, visitor), session);
}

/** Removes the file and forgets it. The extracted skills are left alone. */
export async function DELETE(request: Request) {
  const { visitor, session } = await subjectFor(request);
  if (!session?.user) {
    return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  }
  if (!canWrite()) {
    return NextResponse.json({ error: 'file storage is not configured here' }, { status: 503 });
  }

  const { getProfile } = await import('../../../../src/state/store.js');
  const profile = await getProfile(visitor.id);
  if (profile.resumePath) {
    // A failure to remove the object must not leave the row pointing at a file
    // the person believes is gone — so the record is cleared regardless, and
    // the orphan is logged.
    const { error } = await dbWrite().storage.from(BUCKET).remove([profile.resumePath]);
    if (error) console.error('resume delete failed, orphaned object:', profile.resumePath, error.message);
  }
  const cleared = await clearResumeFile(visitor.id);
  const res = NextResponse.json({ profile: cleared });
  res.headers.set('cache-control', 'private, no-store');
  return attachSession(attachVisitor(res, visitor), session);
}
