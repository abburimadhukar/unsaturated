import type { NextResponse } from 'next/server';

/**
 * Per-visitor identity.
 *
 * Everything used to be keyed to a hardcoded user id of "default", which meant
 * one shared profile for the whole internet: `curl /api/profile` returned the
 * owner's resume-derived skills and `curl /api/state` the exact postings they
 * had opened, and a single POST from anyone overwrote both. Because the feed
 * ranks on profile.skills, that also let a stranger silently rewrite the match
 * scores every visitor saw.
 *
 * An anonymous cookie fixes it without introducing accounts: each browser gets
 * its own opaque id, nobody can address anyone else's row, and there is nothing
 * to log in to.
 */

export const VISITOR_COOKIE = 'uid';

/** A year. Long enough that a returning visitor keeps their saved resume. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export interface Visitor {
  id: string;
  /** True when this request arrived without a cookie and one must be set. */
  isNew: boolean;
}

/**
 * The id state is stored under.
 *
 * A signed-in user is keyed to their account, so their resume and applied-to
 * list follow them to another device or survive clearing cookies. Everyone else
 * keeps the anonymous cookie, so the site works with no sign-in at all.
 */
export interface Subject {
  visitor: Visitor;
  /**
   * The resolved session, when signed in. Routes must hand this to
   * attachSession so a renewed token is stored — Supabase rotates refresh
   * tokens, and dropping the replacement signs the person out.
   */
  session: import('./auth.js').ResolvedSession | null;
}

export async function subjectFor(request: Request): Promise<Subject> {
  try {
    const { resolveSession } = await import('./auth.js');
    const session = await resolveSession(request);
    if (session) return { visitor: { id: `u:${session.user.id}`, isNew: false }, session };
  } catch {
    // Auth unavailable: fall through to the anonymous cookie rather than
    // failing the request.
  }
  return { visitor: visitorFrom(request), session: null };
}

/**
 * Reads the anonymous visitor id off the request, or mints one.
 *
 * Parsed from the raw header rather than next/headers so this works unchanged in
 * route handlers, middleware and tests.
 */
export function visitorFrom(request: Request): Visitor {
  const header = request.headers.get('cookie') ?? '';
  const match = header.match(/(?:^|;\s*)uid=([A-Za-z0-9]{16,64})(?:;|$)/);
  if (match?.[1]) return { id: match[1], isNew: false };
  return { id: crypto.randomUUID().replace(/-/g, ''), isNew: true };
}

/** Sets the cookie on the way out, but only when one was just minted. */
export function attachVisitor(res: NextResponse, visitor: Visitor): NextResponse {
  if (!visitor.isNew) return res;
  res.cookies.set(VISITOR_COOKIE, visitor.id, {
    httpOnly: true,
    sameSite: 'lax',
    // Plain http on localhost would drop a secure cookie, so dev keeps it off.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}
