import { extractSkills } from '../taxonomy/families.js';
import { dbWrite } from '../db/supabase.js';

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
  /** The uploaded file, when there is one. Null for a pasted resume. */
  resumeName: string | null;
  resumeSize: number | null;
  resumePath: string | null;
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

/**
 * Someone the database has never seen.
 *
 * Exported because it is the shape every write starts from for a new person,
 * and that is precisely the case that broke — a test that builds its own
 * stand-in would not have caught it.
 */
export const EMPTY_PROFILE: Profile = {
  skills: [], resumeChars: 0, updatedAt: null, firstName: null, lastName: null,
  resumeName: null, resumeSize: null, resumePath: null,
};

async function load(userId: string): Promise<Cached> {
  const cache = slots();
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.loadedAt < CACHE_MS) return hit;

  const fresh: Cached = { profile: EMPTY_PROFILE, seen: new Set(), applied: new Set(), loadedAt: Date.now() };
  try {
    // THE SECRET KEY, NOT THE PUBLISHABLE ONE, AND FOR READS.
    //
    // Everything in here belongs to one person: their name, the skills pulled
    // out of their CV, the path to the file, every job they have opened. The
    // publishable key is embedded in the deployed page and visible in any
    // browser's network tab, so whatever it can read, the public can read.
    //
    // Verified on the live database, 11 Sep 2026, with nothing but that key:
    // all seven rows came back, including three real people's full names and
    // the size of their resumes. `identity.ts` already says a stranger must not
    // be able to read someone's resume-derived skills; the RLS policy said
    // otherwise, and this read is why the policy had to stay open.
    //
    // Reading server-side with the secret key is what lets that policy be
    // closed — see the migration that narrows it. This call is only ever made
    // from an API route; store.ts is imported by nothing in a client bundle,
    // and the key comes from the environment, which a browser does not have.
    const client = dbWrite();
    const [{ data: st }, { data: ev }] = await Promise.all([
      client.from('user_state').select('skills,resume_chars,updated_at,first_name,last_name,resume_name,resume_size,resume_path').eq('user_id', userId).maybeSingle(),
      client.from('job_events').select('job_key,seen,applied').eq('user_id', userId),
    ]);

    if (st) {
      const row = st as {
        skills: string[] | null; resume_chars: number | null; updated_at: string | null;
        first_name?: string | null; last_name?: string | null;
        resume_name?: string | null; resume_size?: number | null; resume_path?: string | null;
      };
      fresh.profile = {
        skills: row.skills ?? [],
        resumeChars: row.resume_chars ?? 0,
        updatedAt: row.updated_at,
        firstName: row.first_name ?? null,
        lastName: row.last_name ?? null,
        resumeName: row.resume_name ?? null,
        resumeSize: row.resume_size ?? null,
        resumePath: row.resume_path ?? null,
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

/**
 * The CV text, for tailoring. Server-side only.
 *
 * DELIBERATELY NOT PART OF `Profile`
 *
 * Profile is what the browser gets: /api/me, /api/profile, /api/profile/name and
 * /api/profile/resume-file all return one. Putting the CV on it would send
 * thousands of characters of someone's resume down the wire on every page load,
 * and would make a leak exactly one forgotten line away — five routes, each of
 * which would have to remember to strip it. Keeping it off the type means no
 * route can return it by accident, because no route has it.
 *
 * Read fresh every time rather than through the profile cache. It is one narrow
 * column on a seven-row table, read once per tailoring request, and a cache here
 * would only create the chance of tailoring a CV the person has already changed.
 *
 * Returns '' rather than throwing when there is no row, no text, or no database:
 * the caller's next move is the same in all three cases, which is to say "add
 * your resume first".
 */
export async function getResumeText(userId: string): Promise<string> {
  try {
    const { data, error } = await dbWrite()
      .from('user_state')
      .select('resume_text')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('resume text read failed:', error.message);
      return '';
    }
    return (data as { resume_text?: string | null } | null)?.resume_text ?? '';
  } catch (err) {
    console.error('resume text read failed:', err);
    return '';
  }
}

/**
 * Stores the CV text on an existing row.
 *
 * UPDATE and not upsert, naming one column. That is the whole reason this is
 * separate from persistProfile: an UPDATE that does not mention a column cannot
 * touch it, so none of the other writers — setProfileName, setResumeFile,
 * clearResumeFile — can clobber the text, and this cannot clobber them. No
 * assumption about what an upsert does with an absent column is involved.
 *
 * Throws on failure. The caller has just been handed a resume by a person who is
 * waiting to hear whether it was saved, and reporting success for a CV that was
 * not stored would show them skills with no tailoring and no explanation.
 */
async function writeResumeText(userId: string, text: string): Promise<void> {
  const { error } = await dbWrite()
    .from('user_state')
    .update({ resume_text: text })
    .eq('user_id', userId);
  if (error) {
    console.error('resume text save failed:', error.message);
    throw new Error(`could not save resume text: ${error.message}`);
  }
}

export async function setProfileFromResume(userId: string, text: string): Promise<Profile> {
  // The name is not part of a resume upload and must survive one. Reading the
  // current profile first is what stops saving a CV wiping it.
  const current = await getProfile(userId);
  // Spread, not enumerated. Listing every field by hand is how a field gets
  // silently dropped when a new one is added — each of these functions has to
  // preserve everything it does not own, and the only way that stays true is
  // for the default to be "keep it".
  // updatedAt is deliberately not set here. persistProfile stamps it, so there
  // is exactly one place that can get it wrong — see userStateRow.
  const profile: Profile = {
    ...current,
    skills: extractSkills(text),
    resumeChars: text.length,
  };
  const saved = await persistProfile(userId, profile);
  // AFTER persistProfile, not before, and not merged into it.
  //
  // persistProfile upserts, so it is what creates the row for somebody saving a
  // CV before they have any other state — and an UPDATE against a row that does
  // not exist yet silently affects nothing. Ordering this second is what makes a
  // first-ever resume actually store its text.
  await writeResumeText(userId, text);
  return saved;
}

export async function setProfileSkills(userId: string, skills: string[]): Promise<Profile> {
  const current = await getProfile(userId);
  const profile: Profile = {
    ...current,
    skills,
  };
  return await persistProfile(userId, profile);
}

/** The row `user_state` actually stores. */
export interface UserStateRow {
  user_id: string;
  skills: string[];
  resume_chars: number;
  /** Never null. See userStateRow. */
  updated_at: string;
  first_name: string | null;
  last_name: string | null;
  resume_name: string | null;
  resume_size: number | null;
  resume_path: string | null;
}

/**
 * A profile as the row it is written to — and the one place that stamps the time.
 *
 * THE BUG THIS EXISTS FOR
 *
 * `updated_at` is `not null default now()`, and a column DEFAULT applies only
 * when a statement OMITS the column. Supplying an explicit NULL is not the same
 * as leaving it out: Postgres stores the NULL, hits the constraint, and rejects
 * the whole row.
 *
 * Every writer here spreads the current profile, and a person who has no row
 * yet starts from EMPTY_PROFILE, where updatedAt is null. setProfileFromResume and
 * setProfileSkills each happened to overwrite it; setProfileName, setResumeFile
 * and clearResumeFile did not. So those three sent `updated_at: null` and every
 * one of them failed outright for anyone who did not already have a row:
 *
 *   null value in column "updated_at" of relation "user_state"
 *   violates not-null constraint
 *
 * Which is exactly the people it had to work for. Someone signing up is named
 * before they have a row, so /api/me could never store the name from their
 * sign-up form — and that failure is deliberately swallowed there, because a
 * name must not break the page, so it was invisible. Their first resume upload
 * failed the same way, after the file had already been put in storage.
 *
 * Fixed by making this the only place a timestamp is set, so no writer can
 * forget again. A write IS an update, so the row is stamped now — which also
 * makes the admin view's "last active" honest about names and uploads.
 */
export function userStateRow(userId: string, profile: Profile, now = new Date()): UserStateRow {
  return {
    user_id: userId,
    skills: profile.skills,
    resume_chars: profile.resumeChars,
    updated_at: now.toISOString(),
    first_name: profile.firstName,
    last_name: profile.lastName,
    resume_name: profile.resumeName,
    resume_size: profile.resumeSize,
    resume_path: profile.resumePath,
  };
}

/**
 * Saves the profile and returns what was stored, or throws.
 *
 * This used to wrap the call in try/catch and carry on — but supabase-js does
 * not throw on a database error, it RETURNS one, so the catch never ran and the
 * error was not even logged. A save blocked by row level security reported
 * success to the caller and persisted nothing, which is precisely how a
 * misconfigured key went unnoticed: the UI said saved, the row never changed.
 *
 * The error is destructured and thrown, so the route can answer honestly.
 *
 * Returns the stored profile rather than void, so a caller never hands back a
 * timestamp that disagrees with the row.
 */
async function persistProfile(userId: string, profile: Profile): Promise<Profile> {
  const row = userStateRow(userId, profile);
  const { error } = await dbWrite().from('user_state').upsert(row, { onConflict: 'user_id' });
  if (error) {
    console.error('profile save failed:', error.message);
    throw new Error(`could not save profile: ${error.message}`);
  }
  invalidate(userId);
  return { ...profile, updatedAt: row.updated_at };
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
  return await persistProfile(userId, profile);
}

/**
 * Records the uploaded file against the profile.
 *
 * Spread over the current profile, like setProfileName, so uploading a file
 * keeps the skills already extracted and the name already set. The three write
 * paths — name, resume text, resume file — all touch the same row and none of
 * them may erase another's work.
 */
export async function setResumeFile(
  userId: string,
  file: { name: string; size: number; path: string },
): Promise<Profile> {
  const current = await getProfile(userId);
  const profile: Profile = {
    ...current,
    resumeName: file.name,
    resumeSize: file.size,
    resumePath: file.path,
  };
  return await persistProfile(userId, profile);
}

/** Forgets the file. Skills extracted from it are deliberately left in place. */
export async function clearResumeFile(userId: string): Promise<Profile> {
  const current = await getProfile(userId);
  const profile: Profile = {
    ...current,
    resumeName: null,
    resumeSize: null,
    resumePath: null,
  };
  return await persistProfile(userId, profile);
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
