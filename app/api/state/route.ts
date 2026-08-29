import { NextResponse } from 'next/server';
import { getState, markApplied, markSeen } from '../../../src/state/store.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getState());
}

export async function POST(request: Request) {
  const body = (await request.json()) as { key?: string; action?: string };
  const key = body.key;
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });

  if (body.action === 'applied') await markApplied(key);
  else await markSeen(key);

  return NextResponse.json({ ok: true, ...(await getState()) });
}
