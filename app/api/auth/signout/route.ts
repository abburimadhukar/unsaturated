import { NextResponse } from 'next/server';
import { SESSION_COOKIE, REFRESH_COOKIE } from '../../../../src/state/auth.js';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Both, or the next request silently renews the session from the refresh
  // token and signing out does nothing.
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
