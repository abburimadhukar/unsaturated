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

/**
 * Resolves a request to a signed-in user, or null.
 *
 * The seat is re-checked on every request rather than only at sign-in, so
 * releasing a seat locks that person out immediately instead of whenever their
 * token happens to expire.
 */
export async function userFromRequest(request: Request): Promise<SignedInUser | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : cookieToken(request);
  if (!token) return null;

  try {
    const { data, error } = await auth().auth.getUser(token);
    if (error || !data.user?.email) return null;
    const user = { id: data.user.id, email: data.user.email };
    if (!(await hasSeat(token, user.id))) return null;
    return user;
  } catch {
    // An unreachable auth service must not take the feed down with it.
    return null;
  }
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get('cookie') ?? '';
  const m = header.match(/(?:^|;\s*)sb-token=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
