import { NextResponse } from 'next/server';
import { getProfile, setProfileFromResume, setProfileSkills } from '../../../src/state/store.js';
import { attachVisitor, visitorFrom } from '../../../src/state/identity.js';

export const dynamic = 'force-dynamic';

/**
 * The resume profile, scoped to the caller's own cookie.
 *
 * Previously every request read and wrote one shared row, so this endpoint
 * served the site owner's resume skills to anyone who asked for them.
 */
export async function GET(request: Request) {
  const visitor = visitorFrom(request);
  return attachVisitor(NextResponse.json(await getProfile(visitor.id)), visitor);
}

export async function POST(request: Request) {
  const visitor = visitorFrom(request);

  let body: { resume?: string; skills?: string[] };
  try {
    body = (await request.json()) as { resume?: string; skills?: string[] };
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  if (typeof body.resume === 'string' && body.resume.trim()) {
    // Cap the stored text: only the extracted skills are kept, so an
    // unbounded paste is pure cost.
    const resume = body.resume.slice(0, 50_000);
    return attachVisitor(
      NextResponse.json(await setProfileFromResume(visitor.id, resume)),
      visitor,
    );
  }
  if (Array.isArray(body.skills)) {
    const skills = body.skills.slice(0, 200).map(String);
    return attachVisitor(NextResponse.json(await setProfileSkills(visitor.id, skills)), visitor);
  }
  return NextResponse.json({ error: 'send resume text or a skills array' }, { status: 400 });
}
