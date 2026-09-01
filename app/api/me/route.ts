import { NextResponse } from 'next/server';
import { getProfile, getState } from '../../../src/state/store.js';
import { attachVisitor, subjectFor } from '../../../src/state/identity.js';
import {
  resolveSession,
  SESSION_COOKIE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
} from '../../../src/state/auth.js';

/**
 * Everything about the current visitor, and nothing about the job corpus.
 *
 * Split out of /api/feed so that the large, identical-for-everyone job payload
 * can be cached on the CDN. This half is a few hundred bytes, unique per cookie,
 * and must never be held by a shared cache.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const visitor = await subjectFor(request);
  const session = await resolveSession(request);
  const user = session?.user ?? null;

  let profile;
  let state;
  try {
    profile = await getProfile(visitor.id);
    state = await getState(visitor.id);
  } catch (err) {
    // State is a convenience, not the product: an empty profile still renders a
    // working feed, so this degrades rather than failing the page.
    console.error('visitor state load failed:', err);
    profile = { skills: [], resumeChars: 0, updatedAt: null };
    state = { seen: [], applied: [] };
  }

  const res = NextResponse.json({
    profile,
    state,
    // Null when signed out; the UI redirects to /signin rather than showing a
    // half-usable feed.
    user: user ? { email: user.email } : null,
  });
  res.headers.set('cache-control', 'private, no-store');

  // A renewed session has to be written back, or every request re-renews from
  // the same refresh token and the rotation Supabase performs is discarded —
  // which eventually invalidates it. This is the endpoint the client calls on
  // every page load, so it is where the session is kept alive.
  if (session?.renewed) {
    const opts = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    };
    res.cookies.set(SESSION_COOKIE, session.renewed.accessToken, { ...opts, maxAge: 60 * 60 });
    res.cookies.set(REFRESH_COOKIE, session.renewed.refreshToken, {
      ...opts,
      maxAge: REFRESH_MAX_AGE,
    });
  }
  return attachVisitor(res, visitor);
}
