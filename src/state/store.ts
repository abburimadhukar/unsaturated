import { extractSkills } from '../taxonomy/families.js';

/**
 * Process-local user state.
 *
 * Held on globalThis rather than in module scope. Next compiles each route
 * handler separately and re-evaluates modules on hot reload, so plain module
 * state gives /api/profile and /api/feed *different* copies — the profile would
 * save successfully and then read back empty, and seen/applied would never
 * reach the feed. A global singleton is the only thing both routes share.
 *
 * This is still in-memory and resets when the server restarts. It is the seam
 * where candidate_profiles and a seen/applied table get wired in; the shape
 * matches that schema so the swap is a driver change rather than a rewrite.
 */

export interface Profile {
  skills: string[];
  resumeChars: number;
  updatedAt: string | null;
}

interface StoreShape {
  profile: Profile;
  /** Jobs the user has laid eyes on — dimmed in the UI, never hidden. */
  seen: Set<string>;
  /** Inferred from clicking through to the posting, so it over-counts by design. */
  applied: Set<string>;
}

const GLOBAL_KEY = Symbol.for('unsaturated.state');

function store(): StoreShape {
  const g = globalThis as unknown as Record<symbol, StoreShape | undefined>;
  let existing = g[GLOBAL_KEY];
  if (!existing) {
    existing = {
      profile: { skills: [], resumeChars: 0, updatedAt: null },
      seen: new Set(),
      applied: new Set(),
    };
    g[GLOBAL_KEY] = existing;
  }
  return existing;
}

export function getProfile(): Profile {
  return store().profile;
}

export function setProfileFromResume(text: string): Profile {
  const s = store();
  s.profile = {
    skills: extractSkills(text),
    resumeChars: text.length,
    updatedAt: new Date().toISOString(),
  };
  return s.profile;
}

export function setProfileSkills(skills: string[]): Profile {
  const s = store();
  s.profile = { skills, resumeChars: s.profile.resumeChars, updatedAt: new Date().toISOString() };
  return s.profile;
}

export function markSeen(key: string): void {
  store().seen.add(key);
}

export function markApplied(key: string): void {
  const s = store();
  s.applied.add(key);
  s.seen.add(key);
}

export function getState(): { seen: string[]; applied: string[] } {
  const s = store();
  return { seen: [...s.seen], applied: [...s.applied] };
}
