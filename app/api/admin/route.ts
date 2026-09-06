import { NextResponse } from 'next/server';
import { dbWrite, canWrite } from '../../../src/db/supabase.js';
import { subjectFor, attachVisitor } from '../../../src/state/identity.js';
import { attachSession } from '../../../src/state/auth.js';
import { isAdmin } from '../../../src/state/admin.js';

/**
 * Everyone's activity, for the site owner.
 *
 * Four people share this site, and there was no way to see how it was actually
 * being used — how many roles each person had applied to, or whether anyone had
 * added a resume at all.
 *
 * Three things make this safe, and all three matter:
 *
 *   1. The email is taken from the VERIFIED session, never from the request.
 *      A parameter or a header would be settable by anyone.
 *   2. The check runs before any data is read, so a non-admin cannot even cause
 *      the query to happen.
 *   3. It answers 404, not 403. A 403 confirms the route exists and that
 *      someone else has the rights; 404 says nothing at all.
 *
 * Resume TEXT is never returned — only how much of one exists. Seeing what your
 * colleagues have applied to is a shared-team fact; reading their CV is not.
 */
export const dynamic = 'force-dynamic';

interface SeatRow {
  user_id: string;
  email: string;
  created_at?: string | null;
}

interface StateRow {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  skills: string[] | null;
  resume_chars: number | null;
  updated_at: string | null;
}

interface EventRow {
  user_id: string;
  applied: boolean | null;
  seen: boolean | null;
}

export async function GET(request: Request) {
  const { visitor, session } = await subjectFor(request);

  if (!isAdmin(session?.user?.email)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // The seat list and everyone's state are behind row-level security, which is
  // the point of it — so this needs the service key. Without it the query
  // returns an empty list that looks exactly like "nobody has used the site".
  if (!canWrite()) {
    return NextResponse.json(
      { error: 'admin data needs the service key, which is not configured here' },
      { status: 503 },
    );
  }

  const client = dbWrite();

  const [seats, states, marks] = await Promise.all([
    client.from('app_seats').select('user_id,email,created_at'),
    client.from('user_state').select('user_id,first_name,last_name,skills,resume_chars,updated_at'),
    client.from('job_events').select('user_id,applied,seen'),
  ]);

  const failed = [seats.error, states.error, marks.error].find(Boolean);
  if (failed) {
    console.error('admin read failed:', failed.message);
    return NextResponse.json({ error: 'could not read the user list' }, { status: 503 });
  }

  const seatRows = (seats.data ?? []) as unknown as SeatRow[];
  const stateRows = (states.data ?? []) as unknown as StateRow[];
  const markRows = (marks.data ?? []) as unknown as EventRow[];

  // State and marks are keyed "u:<account id>" for signed-in people and by a
  // raw cookie id for anonymous ones. Seats are keyed by the bare account id,
  // so the two only meet across that prefix.
  const tally = new Map<string, { applied: number; seen: number }>();
  for (const m of markRows) {
    const t = tally.get(m.user_id) ?? { applied: 0, seen: 0 };
    if (m.applied) t.applied++;
    if (m.seen) t.seen++;
    tally.set(m.user_id, t);
  }
  const stateOf = new Map(stateRows.map((s) => [s.user_id, s]));

  const users = seatRows.map((seat) => {
    const key = `u:${seat.user_id}`;
    const st = stateOf.get(key);
    const t = tally.get(key) ?? { applied: 0, seen: 0 };
    return {
      email: seat.email,
      firstName: st?.first_name ?? null,
      lastName: st?.last_name ?? null,
      applied: t.applied,
      seen: t.seen,
      // The count, never the text.
      skills: st?.skills?.length ?? 0,
      resumeChars: st?.resume_chars ?? 0,
      lastActive: st?.updated_at ?? null,
      joined: seat.created_at ?? null,
      isYou: seat.email?.toLowerCase() === session?.user?.email?.toLowerCase(),
    };
  });

  users.sort((a, b) => b.applied - a.applied);

  const res = NextResponse.json({
    users,
    seatsUsed: seatRows.length,
    // Anonymous visitors who never signed in. Counted, not listed: there is
    // nothing to identify them by and nothing useful to show.
    anonymousProfiles: stateRows.filter((s) => !s.user_id.startsWith('u:')).length,
  });
  res.headers.set('cache-control', 'private, no-store');
  return attachSession(attachVisitor(res, visitor), session);
}
