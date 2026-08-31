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

const USER_ID = 'default';
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

function slot(): { value: Cached | null } {
  const g = globalThis as unknown as Record<symbol, { value: Cached | null } | undefined>;
  g[CACHE_KEY] ??= { value: null };
  return g[CACHE_KEY]!;
}

const EMPTY: Profile = { skills: [], resumeChars: 0, updatedAt: null };

async function load(): Promise<Cached> {
  const s = slot();
  if (s.value && Date.now() - s.value.loadedAt < CACHE_MS) return s.value;

  const fresh: Cached = { profile: EMPTY, seen: new Set(), applied: new Set(), loadedAt: Date.now() };
  try {
    const client = db();
    const [{ data: st }, { data: ev }] = await Promise.all([
      client.from('user_state').select('skills,resume_chars,updated_at').eq('user_id', USER_ID).maybeSingle(),
      client.from('job_events').select('job_key,seen,applied').eq('user_id', USER_ID),
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

  s.value = fresh;
  return fresh;
}

/** Forces the next read to hit the database. */
function invalidate(): void {
  slot().value = null;
}

export async function getProfile(): Promise<Profile> {
  return (await load()).profile;
}

export async function setProfileFromResume(text: string): Promise<Profile> {
  const profile: Profile = {
    skills: extractSkills(text),
    resumeChars: text.length,
    updatedAt: new Date().toISOString(),
  };
  await persistProfile(profile);
  return profile;
}

export async function setProfileSkills(skills: string[]): Promise<Profile> {
  const current = await getProfile();
  const profile: Profile = {
    skills,
    resumeChars: current.resumeChars,
    updatedAt: new Date().toISOString(),
  };
  await persistProfile(profile);
  return profile;
}

async function persistProfile(profile: Profile): Promise<void> {
  try {
    await dbWrite().from('user_state').upsert(
      {
        user_id: USER_ID,
        skills: profile.skills,
        resume_chars: profile.resumeChars,
        updated_at: profile.updatedAt,
      },
      { onConflict: 'user_id' },
    );
  } catch (err) {
    console.error('profile save failed:', err);
  }
  invalidate();
}

export async function markSeen(key: string): Promise<void> {
  await mark(key, { seen: true, applied: false });
}

export async function markApplied(key: string): Promise<void> {
  // Opening a posting implies having seen it.
  await mark(key, { seen: true, applied: true });
}

async function mark(key: string, flags: { seen: boolean; applied: boolean }): Promise<void> {
  try {
    await dbWrite().from('job_events').upsert(
      { user_id: USER_ID, job_key: key, seen: flags.seen, applied: flags.applied, at: new Date().toISOString() },
      { onConflict: 'user_id,job_key' },
    );
  } catch (err) {
    console.error('job event save failed:', err);
  }
  invalidate();
}

export async function getState(): Promise<{ seen: string[]; applied: string[] }> {
  const s = await load();
  return { seen: [...s.seen], applied: [...s.applied] };
}
