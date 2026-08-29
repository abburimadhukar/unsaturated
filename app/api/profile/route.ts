import { NextResponse } from 'next/server';
import { getProfile, setProfileFromResume, setProfileSkills } from '../../../src/state/store.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getProfile());
}

export async function POST(request: Request) {
  const body = (await request.json()) as { resume?: string; skills?: string[] };

  if (typeof body.resume === 'string' && body.resume.trim()) {
    return NextResponse.json(setProfileFromResume(body.resume));
  }
  if (Array.isArray(body.skills)) {
    return NextResponse.json(setProfileSkills(body.skills.map(String)));
  }
  return NextResponse.json({ error: 'send resume text or a skills array' }, { status: 400 });
}
