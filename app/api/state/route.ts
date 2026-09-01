import { NextResponse } from 'next/server';
import { getState, markApplied, markSeen } from '../../../src/state/store.js';
import { attachVisitor, subjectFor } from '../../../src/state/identity.js';

export const dynamic = 'force-dynamic';

/** Which postings this visitor has seen or opened. Scoped to their own cookie. */
export async function GET(request: Request) {
  const visitor = await subjectFor(request);
  return attachVisitor(NextResponse.json(await getState(visitor.id)), visitor);
}

export async function POST(request: Request) {
  const visitor = await subjectFor(request);

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

  if (body.action === 'applied') await markApplied(visitor.id, key);
  else await markSeen(visitor.id, key);

  return attachVisitor(
    NextResponse.json({ ok: true, ...(await getState(visitor.id)) }),
    visitor,
  );
}
