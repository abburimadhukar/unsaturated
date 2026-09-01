import { NextResponse } from 'next/server';
import { getProfile, getState } from '../../../src/state/store.js';
import { attachVisitor, subjectFor } from '../../../src/state/identity.js';
import { attachSession } from '../../../src/state/auth.js';

/**
 * Everything about the current visitor, and nothing about the job corpus.
 *
 * Split out of /api/feed so that the large, identical-for-everyone job payload
 * can be cached on the CDN. This half is a few hundred bytes, unique per cookie,
 * and must never be held by a shared cache.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { visitor, session } = await subjectFor(request);
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

  return attachSession(attachVisitor(res, visitor), session);
}
