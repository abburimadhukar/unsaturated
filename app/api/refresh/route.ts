import { NextResponse } from 'next/server';
import { refreshFeed } from '../../../src/corpus/live.js';

export const dynamic = 'force-dynamic';

export async function POST() {
  const feed = await refreshFeed();
  return NextResponse.json({
    ok: true,
    total: feed.jobs.length,
    refreshedAt: feed.refreshedAt,
  });
}
