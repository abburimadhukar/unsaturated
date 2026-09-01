import { NextResponse } from 'next/server';
import { getProfile, setProfileFromResume, setProfileSkills } from '../../../src/state/store.js';
import { attachVisitor, subjectFor } from '../../../src/state/identity.js';
import { attachSession } from '../../../src/state/auth.js';

export const dynamic = 'force-dynamic';

/**
 * The resume profile, scoped to the caller.
 *
 * Previously every request read and wrote one shared row, so this endpoint
 * served the site owner's resume skills to anyone who asked for them.
 */
export async function GET(request: Request) {
  const { visitor, session } = await subjectFor(request);
  const res = NextResponse.json(await getProfile(visitor.id));
  return attachSession(attachVisitor(res, visitor), session);
}

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);

  let body: { resume?: string; skills?: string[] };
  try {
    body = (await request.json()) as { resume?: string; skills?: string[] };
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  // A failed save must not answer 200. It used to: supabase-js returns database
  // errors rather than throwing them, nothing checked, and the caller was told
  // the resume had been stored when nothing had been written.
  try {
    if (typeof body.resume === 'string' && body.resume.trim()) {
      // Cap the stored text: only the extracted skills are kept, so an
      // unbounded paste is pure cost.
      const resume = body.resume.slice(0, 50_000);
      const res = NextResponse.json(await setProfileFromResume(visitor.id, resume));
      return attachSession(attachVisitor(res, visitor), session);
    }
    if (Array.isArray(body.skills)) {
      const skills = body.skills.slice(0, 200).map(String);
      const res = NextResponse.json(await setProfileSkills(visitor.id, skills));
      return attachSession(attachVisitor(res, visitor), session);
    }
  } catch (err) {
    console.error('profile write failed:', err);
    return NextResponse.json({ error: 'could not save your resume — try again' }, { status: 503 });
  }

  return NextResponse.json({ error: 'send resume text or a skills array' }, { status: 400 });
}
