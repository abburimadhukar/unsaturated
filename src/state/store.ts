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
  /**
   * Null for anyone who signed in before names were asked for.
   *
   * Not defaulted to the email prefix: that is a username, and showing it as a
   * name would make the account page look filled in when nobody has filled it
   * in. The page prompts instead.
   */
  firstName: string | null;
  lastName: string | null;
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

const EMPTY: Profile = { skills: [], resumeChars: 0, updatedAt: null, firstName: null, lastName: null };

async function load(userId: string): Promise<Cached> {
  const cache = slots();
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.loadedAt < CACHE_MS) return hit;

  const fresh: Cached = { profile: EMPTY, seen: new Set(), applied: new Set(), loadedAt: Date.now() };
  try {
    const client = db();
    const [{ data: st }, { data: ev }] = await Promise.all([
      client.from('user_state').select('skills,resume_chars,updated_at,first_name,last_name').eq('user_id', userId).maybeSingle(),
      client.from('job_events').select('job_key,seen,applied').eq('user_id', userId),
    ]);

    if (st) {
      const row = st as {
        skills: string[] | null; resume_chars: number | null; updated_at: string | null;
        first_name?: string | null; last_name?: string | null;
      };
      fresh.profile = {
        skills: row.skills ?? [],
        resumeChars: row.resume_chars ?? 0,
        updatedAt: row.updated_at,
        firstName: row.first_name ?? null,
        lastName: row.last_name ?? null,
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
  // The name is not part of a resume upload and must survive one. Reading the
  // current profile first is what stops saving a CV wiping it.
  const current = await getProfile(userId);
  const profile: Profile = {
    skills: extractSkills(text),
    resumeChars: text.length,
    updatedAt: new Date().toISOString(),
    firstName: current.firstName,
    lastName: current.lastName,
  };
  await persistProfile(userId, profile);
  return profile;
}

export async function setProfileSkills(userId: string, skills: string[]): Promise<Profile> {
  const current = await getProfile(userId);
  const profile: Profile = {
    skills,
    firstName: current.firstName,
    lastName: current.lastName,
    resumeChars: current.resumeChars,
    updatedAt: new Date().toISOString(),
  };
  await persistProfile(userId, profile);
  return profile;
}

/**
 * Saves the profile, or throws.
 *
 * This used to wrap the call in try/catch and carry on — but supabase-js does
 * not throw on a database error, it RETURNS one, so the catch never ran and the
 * error was not even logged. A save blocked by row level security reported
 * success to the caller and persisted nothing, which is precisely how a
 * misconfigured key went unnoticed: the UI said saved, the row never changed.
 *
 * The error is destructured and thrown, so the route can answer honestly.
 */
async function persistProfile(userId: string, profile: Profile): Promise<void> {
  const { error } = await dbWrite().from('user_state').upsert(
    {
      user_id: userId,
      skills: profile.skills,
      resume_chars: profile.resumeChars,
      updated_at: profile.updatedAt,
      first_name: profile.firstName,
      last_name: profile.lastName,
    },
    { onConflict: 'user_id' },
  );
  if (error) {
    console.error('profile save failed:', error.message);
    throw new Error(`could not save profile: ${error.message}`);
  }
  invalidate(userId);
}

/**
 * Sets the person's name.
 *
 * Separate from the resume path because the two are edited in different places
 * and neither may clobber the other: saving a CV must not erase a name, and
 * renaming yourself must not drop your skills.
 */
export async function setProfileName(
  userId: string,
  firstName: string,
  lastName: string,
): Promise<Profile> {
  const current = await getProfile(userId);
  const profile: Profile = {
    ...current,
    firstName: firstName.trim() || null,
    lastName: lastName.trim() || null,
  };
  await persistProfile(userId, profile);
  return profile;
}

export async function markSeen(userId: string, key: string): Promise<void> {
  await mark(userId, key, { seen: true, applied: false });
}

export async function markApplied(userId: string, key: string): Promise<void> {
  // Opening a posting implies having seen it.
  await mark(userId, key, { seen: true, applied: true });
}

/** Records seen/applied, or throws. See persistProfile for why it must throw. */
async function mark(userId: string, key: string, flags: { seen: boolean; applied: boolean }): Promise<void> {
  const { error } = await dbWrite().from('job_events').upsert(
    { user_id: userId, job_key: key, seen: flags.seen, applied: flags.applied, at: new Date().toISOString() },
    { onConflict: 'user_id,job_key' },
  );
  if (error) {
    console.error('job event save failed:', error.message);
    throw new Error(`could not record that job: ${error.message}`);
  }
  invalidate(userId);
}

export async function getState(userId: string): Promise<{ seen: string[]; applied: string[] }> {
  const s = await load(userId);
  return { seen: [...s.seen], applied: [...s.applied] };
}
