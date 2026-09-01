import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
  SEAT_LIMIT,
  auth,
  claimSeat,
} from '../../../../src/state/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Exchanges the token from a clicked magic link for a session, claiming a seat.
 *
 * Supabase hands the browser its token in the URL fragment, which never reaches
 * the server, so the page posts it here. This is the point where a seat is
 * taken: the address has now been proved, which is why a typo at the sign-in
 * box costs nothing.
 */
export async function POST(request: Request) {
  let token: string;
  let refresh: string;
  try {
    const body = (await request.json()) as { access_token?: string; refresh_token?: string };
    token = String(body.access_token ?? '');
    refresh = String(body.refresh_token ?? '');
  } catch {
    return NextResponse.json({ error: 'no token' }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: 'no token' }, { status: 400 });

  const { data, error } = await auth().auth.getUser(token);
  if (error || !data.user?.email) {
    return NextResponse.json({ error: 'that link is not valid or has expired' }, { status: 401 });
  }
  const user = { id: data.user.id, email: data.user.email };

  const claim = await claimSeat(token, user);
  if (claim === 'full') {
    return NextResponse.json(
      {
        error: `This site has ${SEAT_LIMIT} accounts and all of them are taken. Ask whoever runs it to free one.`,
      },
      { status: 403 },
    );
  }
  if (claim === 'error') {
    return NextResponse.json({ error: 'could not complete sign-in, try again' }, { status: 500 });
  }

  const res = NextResponse.json({ email: user.email, claimed: claim === 'claimed' });
  const opts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
  // Matches Supabase's default access-token lifetime.
  res.cookies.set(SESSION_COOKIE, token, { ...opts, maxAge: 60 * 60 });
  // The refresh token is what makes the session outlive that hour. Without it a
  // new magic link would be needed hourly, against a sender that allows about
  // two emails an hour.
  if (refresh) res.cookies.set(REFRESH_COOKIE, refresh, { ...opts, maxAge: REFRESH_MAX_AGE });
  return res;
}
