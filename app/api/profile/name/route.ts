import { NextResponse } from 'next/server';
import { setProfileName } from '../../../../src/state/store.js';
import { attachVisitor, subjectFor } from '../../../../src/state/identity.js';
import { attachSession } from '../../../../src/state/auth.js';

/**
 * Sets the signed-in person's name.
 *
 * Separate from /api/profile, which takes a resume: the two are edited on
 * different controls and one must never overwrite the other. Saving a CV keeps
 * your name; renaming yourself keeps your skills.
 */
export const dynamic = 'force-dynamic';

/** Long enough for any real name, short enough that the column is not a note field. */
const MAX = 60;

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);

  // Signed out, there is nobody to name. The anonymous cookie identity exists so
  // the feed works before sign-in; attaching a name to it would write a row that
  // the account it eventually belongs to never sees.
  if (!session?.user) {
    return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  }

  let firstName = '';
  let lastName = '';
  try {
    const body = (await request.json()) as { firstName?: unknown; lastName?: unknown };
    firstName = String(body.firstName ?? '').trim();
    lastName = String(body.lastName ?? '').trim();
  } catch {
    return NextResponse.json({ error: 'send a first and last name' }, { status: 400 });
  }

  const problems: string[] = [];
  if (!firstName) problems.push('first name is required');
  if (!lastName) problems.push('last name is required');
  if (firstName.length > MAX) problems.push(`first name must be ${MAX} characters or fewer`);
  if (lastName.length > MAX) problems.push(`last name must be ${MAX} characters or fewer`);
  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join('; ') }, { status: 400 });
  }

  try {
    const profile = await setProfileName(visitor.id, firstName, lastName);
    const res = NextResponse.json({ profile });
    res.headers.set('cache-control', 'private, no-store');
    return attachSession(attachVisitor(res, visitor), session);
  } catch (err) {
    // supabase-js reports failures rather than throwing, and setProfileName
    // turns that into a throw — so a save that silently did nothing cannot
    // answer 200 the way it once did.
    console.error('name save failed:', err);
    return NextResponse.json({ error: 'could not save your name' }, { status: 503 });
  }
}
