import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Sign-in for a small, fixed group.
 *
 * Anonymous cookies gave each browser its own profile, which fixed the shared-
 * identity leak but tied a person's saved resume and applied-to list to one
 * device: clearing cookies or switching to a laptop lost everything.
 *
 * This is a magic link — type an email, click the link, you are in. There are no
 * passwords to store, reset or leak, and Supabase Auth is already part of the
 * project. An allow-list keeps it to the intended four people: Supabase will
 * happily send a link to any address, so the check has to be ours.
 *
 * Signed-out visitors keep working exactly as before, on their anonymous cookie.
 * Signing in is what makes state follow you between devices.
 */

const URL = process.env.SUPABASE_URL ?? 'https://vupjabahniolbnbmeidk.supabase.co';
const PUBLISHABLE =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_BUdygNHc_QserbZ0tSJBWg_pGBwmfYq';

/**
 * Who may sign in, as a comma-separated ALLOWED_EMAILS environment variable.
 *
 * Deliberately not hardcoded: the repo is public, and a list of real email
 * addresses in a public file is an invitation to spam. With the variable unset
 * nobody can sign in, which fails closed rather than open.
 */
export function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(email: string): boolean {
  const list = allowedEmails();
  if (list.length === 0) return false;
  return list.includes(email.trim().toLowerCase());
}

let client: SupabaseClient | null = null;

/** Auth client. Separate from the data clients: different session semantics. */
export function auth(): SupabaseClient {
  client ??= createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export interface SignedInUser {
  id: string;
  email: string;
}

/**
 * Resolves the bearer token on a request to a user, or null.
 *
 * The allow-list is re-checked here, not only at sign-in: removing someone from
 * ALLOWED_EMAILS should lock them out immediately, and it would not if a token
 * issued while they were permitted kept working until it expired.
 */
export async function userFromRequest(request: Request): Promise<SignedInUser | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : cookieToken(request);
  if (!token) return null;

  try {
    const { data, error } = await auth().auth.getUser(token);
    if (error || !data.user?.email) return null;
    if (!isAllowed(data.user.email)) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    // An unreachable auth service must not take the feed down with it.
    return null;
  }
}

export const SESSION_COOKIE = 'sb-token';

function cookieToken(request: Request): string | null {
  const header = request.headers.get('cookie') ?? '';
  const m = header.match(/(?:^|;\s*)sb-token=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
