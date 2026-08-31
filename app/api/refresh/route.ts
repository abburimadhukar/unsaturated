import { NextResponse } from 'next/server';
import { refreshFeed } from '../../../src/corpus/live.js';

export const dynamic = 'force-dynamic';

/**
 * Trigger a live crawl of every board.
 *
 * Gated, because unauthenticated this is a free amplifier: one POST makes the
 * site fetch all 1,437 third-party ATS endpoints under our own user agent, and
 * refreshFeed only collapses *concurrent* calls — serial POSTs each start a new
 * sweep. That is an IP-ban and reputation risk for the crawler identity, not
 * merely a compute cost.
 *
 * Nothing in the UI calls this; it exists for manual operator use. With no
 * REFRESH_TOKEN configured the route does not exist at all.
 */
export async function POST(req: Request) {
  const expected = process.env.REFRESH_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (req.headers.get('x-refresh-token') !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const feed = await refreshFeed();
  return NextResponse.json({
    ok: true,
    total: feed.jobs.length,
    refreshedAt: feed.refreshedAt,
  });
}
