import { NextResponse } from 'next/server';
import { auth, seatsTaken, SEAT_LIMIT } from '../../../../src/state/auth.js';

export const dynamic = 'force-dynamic';

/**
 * Sends a sign-in link.
 *
 * Nothing is claimed here. A seat is only taken when the emailed link is
 * clicked, so a mistyped address cannot burn one of the four.
 *
 * When the seats are full the reply is the same whoever asks, because a
 * different answer for seat-holders would turn this into a way to test which
 * addresses hold accounts. A fifth person simply never receives an email; the
 * message says as much without naming anyone.
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

  const taken = await seatsTaken();
  const full = taken >= SEAT_LIMIT;

  const origin = new URL(request.url).origin;
  const { error } = await auth().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/`,
      // Supabase creating the account is fine — holding an account is not the
      // same as holding a seat, and the seat is what grants access.
      shouldCreateUser: true,
    },
  });
  if (error) {
    console.error('sign-in link failed:', error.message);
    // Supabase rejects reserved domains (example.com) and malformed addresses
    // outright. Reporting that as a server problem sends someone off to retry
    // an address that will never work.
    if (/invalid/i.test(error.message)) {
      return NextResponse.json(
        { error: 'that address was rejected as invalid — check it and try again' },
        { status: 400 },
      );
    }
    if (/rate limit|too many/i.test(error.message)) {
      return NextResponse.json(
        { error: 'too many sign-in emails just now — wait a minute and try again' },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: 'could not send the link, try again shortly' }, { status: 502 });
  }

  return NextResponse.json({
    sent: true,
    seatsLeft: Math.max(0, SEAT_LIMIT - taken),
    message: full
      ? `All ${SEAT_LIMIT} accounts on this site are taken. If one of them is yours, a sign-in link is on its way.`
      : 'Check your email for a sign-in link.',
  });
}
