/**
 * Carries the name typed on the sign-in form across the magic-link round trip.
 *
 * THE BUG THIS EXISTS FOR
 *
 * The sign-in form asks everyone for a first and last name and refuses to send
 * the link without them. For anyone who already had an account, it then threw
 * both away.
 *
 * The name was passed to Supabase as `signInWithOtp({ options: { data } })`,
 * and Supabase applies that only when it CREATES the user. For an existing
 * account it is ignored — silently, with no error. /api/me then had nothing in
 * the account metadata to copy across, so no name was ever stored and the form
 * gave no hint that the answer had gone nowhere.
 *
 * Measured on the live database: five user_state rows, first_name and last_name
 * null on every one of them, and the account actively applying to jobs that day
 * had no row at all.
 *
 * WHY localStorage
 *
 * The name is only needed for the few minutes between typing it and clicking
 * the link, and it is already sitting in the browser that typed it. A cookie
 * would travel to the server on every request for no reason, and a pending
 * table server-side is a schema change and a cleanup job for a value with a
 * five-minute life.
 *
 * If the link is opened in a DIFFERENT browser the name simply is not there —
 * which is exactly what happens today, so this is never worse, and the account
 * page still sets it.
 *
 * Kept out of the page component so it can be tested without React.
 */

export const PENDING_NAME_KEY = 'unsaturated.pendingName';

export interface PendingName {
  firstName: string;
  lastName: string;
}

/** The two calls this needs, so a test can supply its own. */
export interface NameEnv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  fetch: typeof fetch;
}

function browserEnv(): NameEnv {
  return {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
    fetch: (...args) => fetch(...args),
  };
}

export function rememberName(firstName: string, lastName: string, env: NameEnv = browserEnv()): void {
  try {
    env.setItem(PENDING_NAME_KEY, JSON.stringify({ firstName, lastName }));
  } catch {
    // Private browsing and blocked site data both throw here. A name is a
    // nicety and must never stop someone signing in.
  }
}

function readPending(env: NameEnv): PendingName | null {
  try {
    const raw = env.getItem(PENDING_NAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingName>;
    const firstName = String(parsed.firstName ?? '').trim();
    const lastName = String(parsed.lastName ?? '').trim();
    // The API requires both, so half a name is not worth a request that can
    // only answer 400.
    if (!firstName || !lastName) return null;
    return { firstName, lastName };
  } catch {
    return null;
  }
}

/**
 * Saves the remembered name, once there is a session to attach it to.
 *
 * ONLY when the profile has none. Someone who set their name on the account
 * page and later signed in again must not have it overwritten by whatever the
 * form happened to be holding — the same rule /api/me already applies to the
 * account metadata it copies across.
 *
 * Returns what it did, so the caller and the tests can tell the difference
 * between "nothing to do" and "tried and failed".
 */
export async function applyPendingName(
  env: NameEnv = browserEnv(),
): Promise<'saved' | 'kept-existing' | 'nothing-pending' | 'failed'> {
  const pending = readPending(env);
  if (!pending) return 'nothing-pending';

  let outcome: 'saved' | 'kept-existing' | 'failed' = 'failed';
  try {
    const me = await env.fetch('/api/me');
    if (me.ok) {
      const body = (await me.json()) as {
        profile?: { firstName: string | null; lastName: string | null };
      };
      if (body.profile?.firstName || body.profile?.lastName) {
        outcome = 'kept-existing';
      } else {
        const saved = await env.fetch('/api/profile/name', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(pending),
        });
        outcome = saved.ok ? 'saved' : 'failed';
      }
    }
  } catch {
    // Never block the redirect on this — the account page can still set it.
    outcome = 'failed';
  }

  // Cleared on success and when a name already existed. A failure keeps it, so
  // the next sign-in gets another go rather than losing it for good.
  if (outcome !== 'failed') {
    try {
      env.removeItem(PENDING_NAME_KEY);
    } catch {
      // Harmless: the "only when empty" check above makes a leftover value a
      // no-op next time.
    }
  }
  return outcome;
}
