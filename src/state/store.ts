import { extractSkills } from '../taxonomy/families.js';
import { db, dbWrite } from '../db/supabase.js';

/**
 * User state: resume skills, and which jobs have been seen or opened.
 *
 * Persisted in Supabase so it survives restarts and redeploys — previously this
 * lived only in process memory and was wiped by every deploy, which made the
 * "hide ones I've opened" filter useless in practice.
 *
 * Single user for now, keyed by USER_ID so adding real accounts later is a
 * policy change rather than a schema migration. Reads are cached in memory for
 * a few seconds because the feed endpoint needs this on every request and the
 * data changes rarely.
 */

const CACHE_MS = 5_000;

export interface Profile {
  skills: string[];
  resumeChars: number;
  updatedAt: string | null;
}

interface Cached {
  profile: Profile;
  seen: Set<string>;
  applied: Set<string>;
  loadedAt: number;
}

const CACHE_KEY = Symbol.for('unsaturated.state');

/**
 * One cache entry per visitor. This was a single shared slot, so on a warm
 * serverless instance one visitor's cached profile was served to the next.
 * Bounded so a stream of distinct cookies cannot grow it without limit.
 */
const MAX_CACHED_VISITORS = 500;

function slots(): Map<string, Cached> {
  const g = globalThis as unknown as Record<symbol, Map<string, Cached> | undefined>;
  g[CACHE_KEY] ??= new Map<string, Cached>();
  return g[CACHE_KEY]!;
}

const EMPTY: Profile = { skills: [], resumeChars: 0, updatedAt: null };

async function load(userId: string): Promise<Cached> {
  const cache = slots();
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.loadedAt < CACHE_MS) return hit;

  const fresh: Cached = { profile: EMPTY, seen: new Set(), applied: new Set(), loadedAt: Date.now() };
  try {
    const client = db();
    const [{ data: st }, { data: ev }] = await Promise.all([
      client.from('user_state').select('skills,resume_chars,updated_at').eq('user_id', userId).maybeSingle(),
      client.from('job_events').select('job_key,seen,applied').eq('user_id', userId),
    ]);

    if (st) {
      const row = st as { skills: string[] | null; resume_chars: number | null; updated_at: string | null };
      fresh.profile = {
        skills: row.skills ?? [],
        resumeChars: row.resume_chars ?? 0,
        updatedAt: row.updated_at,
      };
    }
    for (const e of (ev ?? []) as { job_key: string; seen: boolean; applied: boolean }[]) {
      if (e.seen) fresh.seen.add(e.job_key);
      if (e.applied) fresh.applied.add(e.job_key);
    }
  } catch (err) {
    // State is a convenience, not the product. If the database is unreachable
    // the feed must still render rather than erroring out.
    console.error('user state load failed:', err);
  }

  // Simple FIFO eviction — this is a short-lived read cache, not a store.
  if (cache.size >= MAX_CACHED_VISITORS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, fresh);
  return fresh;
}

/** Forces the next read for this visitor to hit the database. */
function invalidate(userId: string): void {
  slots().delete(userId);
}

export async function getProfile(userId: string): Promise<Profile> {
  return (await load(userId)).profile;
}

export async function setProfileFromResume(userId: string, text: string): Promise<Profile> {
  const profile: Profile = {
    skills: extractSkills(text),
    resumeChars: text.length,
    updatedAt: new Date().toISOString(),
  };
  await persistProfile(userId, profile);
  return profile;
}

export async function setProfileSkills(userId: string, skills: string[]): Promise<Profile> {
  const current = await getProfile(userId);
  const profile: Profile = {
    skills,
    resumeChars: current.resumeChars,
    updatedAt: new Date().toISOString(),
  };
  await persistProfile(userId, profile);
  return profile;
}

async function persistProfile(userId: string, profile: Profile): Promise<void> {
  try {
    await dbWrite().from('user_state').upsert(
      {
        user_id: userId,
        skills: profile.skills,
        resume_chars: profile.resumeChars,
        updated_at: profile.updatedAt,
      },
      { onConflict: 'user_id' },
    );
  } catch (err) {
    console.error('profile save failed:', err);
  }
  invalidate(userId);
}

export async function markSeen(userId: string, key: string): Promise<void> {
  await mark(userId, key, { seen: true, applied: false });
}

export async function markApplied(userId: string, key: string): Promise<void> {
  // Opening a posting implies having seen it.
  await mark(userId, key, { seen: true, applied: true });
}

async function mark(userId: string, key: string, flags: { seen: boolean; applied: boolean }): Promise<void> {
  try {
    await dbWrite().from('job_events').upsert(
      { user_id: userId, job_key: key, seen: flags.seen, applied: flags.applied, at: new Date().toISOString() },
      { onConflict: 'user_id,job_key' },
    );
  } catch (err) {
    console.error('job event save failed:', err);
  }
  invalidate(userId);
}

export async function getState(userId: string): Promise<{ seen: string[]; applied: string[] }> {
  const s = await load(userId);
  return { seen: [...s.seen], applied: [...s.applied] };
}
