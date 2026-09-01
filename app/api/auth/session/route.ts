import { NextResponse } from 'next/server';
import { SESSION_COOKIE, isAllowed, auth } from '../../../../src/state/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Exchanges the token from a clicked magic link for a session cookie.
 *
 * Supabase hands the browser its token in the URL fragment, which never reaches
 * the server. The page posts it here, the allow-list is checked once more, and
 * it is stored httpOnly so page scripts cannot read it.
 */
export async function POST(request: Request) {
  let token: string;
  try {
    const body = (await request.json()) as { access_token?: string };
    token = String(body.access_token ?? '');
  } catch {
    return NextResponse.json({ error: 'no token' }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: 'no token' }, { status: 400 });

  const { data, error } = await auth().auth.getUser(token);
  if (error || !data.user?.email) {
    return NextResponse.json({ error: 'that link is not valid' }, { status: 401 });
  }
  if (!isAllowed(data.user.email)) {
    return NextResponse.json({ error: 'that account is not permitted' }, { status: 403 });
  }

  const res = NextResponse.json({ email: data.user.email });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Matches Supabase's default access-token lifetime.
    maxAge: 60 * 60,
  });
  return res;
}
