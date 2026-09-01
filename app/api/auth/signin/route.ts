import { NextResponse } from 'next/server';
import { auth, isAllowed } from '../../../../src/state/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Sends a sign-in link.
 *
 * Answers the same way whether or not the address is on the allow-list. Telling
 * a caller "that email is not permitted" turns this endpoint into a way to test
 * which of four addresses are the real ones.
 */
export async function POST(request: Request) {
  let email: string;
  try {
    const body = (await request.json()) as { email?: string };
    email = String(body.email ?? '').trim();
  } catch {
    return NextResponse.json({ error: 'send an email address' }, { status: 400 });
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'that does not look like an email address' }, { status: 400 });
  }

  const ok = { sent: true, message: 'If that address is registered, a sign-in link is on its way.' };
  if (!isAllowed(email)) return NextResponse.json(ok);

  const origin = new URL(request.url).origin;
  const { error } = await auth().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/`,
      // Nobody signs up here; the four accounts are provisioned by the
      // allow-list, and letting Supabase create users would let a typo make one.
      shouldCreateUser: true,
    },
  });
  if (error) {
    console.error('sign-in link failed:', error.message);
    return NextResponse.json({ error: 'could not send the link, try again shortly' }, { status: 502 });
  }
  return NextResponse.json(ok);
}
