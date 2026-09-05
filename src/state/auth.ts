import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Sign-in for four people, with nothing to configure.
 *
 * Anonymous cookies fixed the shared-identity leak but tied a person's resume
 * and applied-to list to one browser: clearing cookies or moving to a laptop
 * lost it. This is a magic link — type an email, click the link — so there are
 * no passwords to store, reset or leak.
 *
 * Who is allowed is not a list anyone maintains. There are four seats, and the
 * first four people to complete a sign-in take them; the fifth is refused. A
 * seat is keyed to the Supabase auth user id, so it can only be claimed by
 * someone who has proved they own the address — a typo cannot burn a seat,
 * because nothing is claimed until the emailed link is clicked.
 *
 * The cap lives in a database trigger rather than here. Application code would
 * have to count, then insert, and two people signing in at the same moment
 * would both pass the count.
 *
 * Signed-out visitors keep working exactly as before on their anonymous cookie.
 * Signing in is what makes state follow you between devices.
 */

const URL = process.env.SUPABASE_URL ?? 'https://vupjabahniolbnbmeidk.supabase.co';
const PUBLISHABLE =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_BUdygNHc_QserbZ0tSJBWg_pGBwmfYq';

export const SEAT_LIMIT = 4;
export const SESSION_COOKIE = 'sb-token';

/**
 * The refresh token, kept so a session outlives its access token.
 *
 * Supabase access tokens expire after an hour. Storing only that meant a new
 * magic link every hour — against a sender that allows about two emails an
 * hour, which is unusable. The refresh token renews the session silently for
 * weeks, so the email is needed once rather than hourly.
 */
export const REFRESH_COOKIE = 'sb-refresh';

/** Thirty days. Long enough that signing in feels like it stuck. */
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

let anon: SupabaseClient | null = null;

/** Unauthenticated client, for verifying tokens and counting free seats. */
export function auth(): SupabaseClient {
  anon ??= createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return anon;
}

/**
 * A client acting AS the signed-in user.
 *
 * Row level security keys off auth.uid(), so the token has to travel with the
 * request or the seat policies see an anonymous caller and refuse.
 */
function asUser(token: string): SupabaseClient {
  return createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** How many of the four seats are taken. Returns a count, never an address. */
export async function seatsTaken(): Promise<number> {
  try {
    const { data, error } = await auth().rpc('seats_taken');
    if (error) return SEAT_LIMIT; // Unknown: assume full rather than let a fifth in.
    return typeof data === 'number' ? data : SEAT_LIMIT;
  } catch {
    return SEAT_LIMIT;
  }
}

export interface SignedInUser {
  id: string;
  email: string;
  /**
   * Whatever was typed into the sign-in form when the account was created.
   *
   * Supabase writes this once, at account creation, and ignores it on every
   * later sign-in — which is why it is copied into user_state on first read
   * rather than being the place the name actually lives.
   */
  metadata?: { first_name?: string; last_name?: string };
}

/** True when this user already holds a seat. */
async function hasSeat(token: string, userId: string): Promise<boolean> {
  const { data, error } = await asUser(token)
    .from('app_seats')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  return !error && data !== null;
}

export type ClaimResult = 'held' | 'claimed' | 'full' | 'error';

/**
 * Gives this user a seat, or reports why not.
 *
 * Called only after the token has been verified, so reaching here means the
 * address was genuinely received and clicked.
 */
export async function claimSeat(token: string, user: SignedInUser): Promise<ClaimResult> {
  try {
    if (await hasSeat(token, user.id)) return 'held';

    const { error } = await asUser(token)
      .from('app_seats')
      .insert({ user_id: user.id, email: user.email });
    if (!error) return 'claimed';

    // The trigger raises 'seats_full'; a unique violation means they claimed a
    // seat in a parallel request, which is a success, not a failure.
    if (/seats_full/.test(error.message)) return 'full';
    if (error.code === '23505') return 'held';
    console.error('seat claim failed:', error.message);
    return 'error';
  } catch (err) {
    console.error('seat claim failed:', err);
    return 'error';
  }
}

export interface ResolvedSession {
  user: SignedInUser;
  /** Set when the access token was renewed and the cookies need rewriting. */
  renewed?: { accessToken: string; refreshToken: string };
}

/**
 * Resolves a request to a signed-in user, renewing the session if it has aged
 * out.
 *
 * The seat is re-checked every time rather than only at sign-in, so releasing a
 * seat locks that person out immediately instead of whenever their token
 * happens to expire.
 */
export async function resolveSession(request: Request): Promise<ResolvedSession | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : cookie(request, 'sb-token');

  if (token) {
    try {
      const { data, error } = await auth().auth.getUser(token);
      if (!error && data.user?.email) {
        const user = {
          id: data.user.id,
          email: data.user.email,
          metadata: (data.user.user_metadata ?? {}) as { first_name?: string; last_name?: string },
        };
        if (await hasSeat(token, user.id)) return { user };
        return null;
      }
    } catch {
      // Fall through to the refresh attempt rather than signing them out.
    }
  }

  // Access token missing or expired: renew it.
  const refresh = cookie(request, 'sb-refresh');
  if (!refresh) return null;
  try {
    const { data, error } = await auth().auth.refreshSession({ refresh_token: refresh });
    const session = data.session;
    if (error || !session?.access_token || !data.user?.email) return null;
    const user = {
      id: data.user.id,
      email: data.user.email,
      metadata: (data.user.user_metadata ?? {}) as { first_name?: string; last_name?: string },
    };
    if (!(await hasSeat(session.access_token, user.id))) return null;
    return {
      user,
      renewed: {
        accessToken: session.access_token,
        // Supabase rotates refresh tokens, so the new one has to be stored or
        // the next renewal fails.
        refreshToken: session.refresh_token ?? refresh,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Writes a renewed session back to the browser.
 *
 * Every route that resolves a session must call this, not just the one that
 * reads the profile. Supabase ROTATES the refresh token each time it is used,
 * so a route that renews without storing the replacement silently consumes the
 * stored one — the next request then finds a token Supabase has already
 * retired, and the person is signed out mid-session. That is precisely the
 * "signed out an hour later" behaviour this is meant to prevent.
 *
 * Typed loosely on the response so it works with any NextResponse without
 * dragging next/server into this module.
 */
export function attachSession<T extends { cookies: { set: (name: string, value: string, opts: Record<string, unknown>) => unknown } }>(
  res: T,
  session: ResolvedSession | null,
): T {
  if (!session?.renewed) return res;
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
  return res;
}

/** Convenience wrapper for callers that only need to know who is asking. */
export async function userFromRequest(request: Request): Promise<SignedInUser | null> {
  return (await resolveSession(request))?.user ?? null;
}

/**
 * Reads one cookie by name.
 *
 * Split rather than matched. Building the pattern in a template literal put a
 * `\s` in it, which JavaScript collapses to a bare "s" — the expression compiled
 * to `;s*` and only matched a cookie sitting first in the header. Since every
 * visitor also carries a `uid` cookie, the session cookie was never first, so
 * signing in appeared to work and then immediately did not.
 */
function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}
