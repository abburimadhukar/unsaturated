import { NextResponse } from 'next/server';
import { getState, markApplied, markSeen } from '../../../src/state/store.js';
import { attachVisitor, subjectFor } from '../../../src/state/identity.js';
import { attachSession } from '../../../src/state/auth.js';

export const dynamic = 'force-dynamic';

/** Which postings this visitor has seen or opened. Scoped to their own account. */
export async function GET(request: Request) {
  const { visitor, session } = await subjectFor(request);
  const res = NextResponse.json(await getState(visitor.id));
  // attachSession as well as attachVisitor: Supabase rotates refresh tokens, so
  // a route that renews one without storing the replacement signs the person out
  // on their next request.
  return attachSession(attachVisitor(res, visitor), session);
}

export async function POST(request: Request) {
  const { visitor, session } = await subjectFor(request);

  let body: { key?: string; action?: string };
  try {
    body = (await request.json()) as { key?: string; action?: string };
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  // Job keys are "provider:token:externalId". Validating the shape stops the
  // table being stuffed with arbitrary strings.
  if (!key || key.length > 200 || !/^[a-z]+:[^:]+:.+$/i.test(key)) {
    return NextResponse.json({ error: 'a valid job key is required' }, { status: 400 });
  }

  // A write that did not happen must not answer ok. supabase-js returns errors
  // rather than throwing them, so this used to report success either way.
  try {
    if (body.action === 'applied') await markApplied(visitor.id, key);
    else await markSeen(visitor.id, key);
  } catch (err) {
    console.error('job event write failed:', err);
    return NextResponse.json({ error: 'could not record that — try again' }, { status: 503 });
  }

  const res = NextResponse.json({ ok: true, ...(await getState(visitor.id)) });
  return attachSession(attachVisitor(res, visitor), session);
}
