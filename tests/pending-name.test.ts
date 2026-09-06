import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyPendingName,
  rememberName,
  PENDING_NAME_KEY,
  type NameEnv,
} from '../src/ui/pending-name.js';

/**
 * The sign-in form asked for a name and threw it away.
 *
 * Supabase applies the `data` passed to signInWithOtp only when it CREATES the
 * account; for an existing one it is ignored, silently. So everyone who already
 * had an account typed their name into a required field that went nowhere, and
 * nothing anywhere said so. Measured on the live database: five user_state
 * rows, first_name and last_name null on every one.
 */

interface Recorded {
  url: string;
  body?: unknown;
}

function env(opts: {
  stored?: string | null;
  profile?: { firstName: string | null; lastName: string | null };
  meOk?: boolean;
  saveOk?: boolean;
  throwOnGet?: boolean;
  throwOnSet?: boolean;
  throwOnRemove?: boolean;
}): { env: NameEnv; calls: Recorded[]; store: Map<string, string> } {
  const store = new Map<string, string>();
  if (opts.stored) store.set(PENDING_NAME_KEY, opts.stored);
  const calls: Recorded[] = [];

  const e: NameEnv = {
    getItem: (k) => {
      if (opts.throwOnGet) throw new Error('blocked');
      return store.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (opts.throwOnSet) throw new Error('blocked');
      store.set(k, v);
    },
    removeItem: (k) => {
      if (opts.throwOnRemove) throw new Error('blocked');
      store.delete(k);
    },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes('/api/me')) {
        return {
          ok: opts.meOk ?? true,
          json: async () => ({
            profile: opts.profile ?? { firstName: null, lastName: null },
          }),
        } as Response;
      }
      return { ok: opts.saveOk ?? true } as Response;
    }) as unknown as typeof fetch,
  };
  return { env: e, calls, store };
}

const PENDING = JSON.stringify({ firstName: 'Madhukar', lastName: 'Abburi' });

test('a name typed at sign-in is saved once there is a session', async () => {
  const { env: e, calls, store } = env({ stored: PENDING });
  assert.equal(await applyPendingName(e), 'saved');

  const save = calls.find((c) => c.url.includes('/api/profile/name'));
  assert.ok(save, 'the name was never sent');
  assert.deepEqual(save.body, { firstName: 'Madhukar', lastName: 'Abburi' });

  // Cleared, so a later sign-in does not re-apply a stale value.
  assert.equal(store.has(PENDING_NAME_KEY), false);
});

test('a name already on the profile is never overwritten', async () => {
  // Someone who set their name on the account page and signed in again must
  // keep it — the same rule /api/me applies to the account metadata it copies.
  const { env: e, calls, store } = env({
    stored: JSON.stringify({ firstName: 'Old', lastName: 'Form' }),
    profile: { firstName: 'Madhukar', lastName: 'Abburi' },
  });
  assert.equal(await applyPendingName(e), 'kept-existing');
  assert.equal(calls.some((c) => c.url.includes('/api/profile/name')), false);
  assert.equal(store.has(PENDING_NAME_KEY), false, 'stale value should still be cleared');
});

test('nothing stored means no requests at all', async () => {
  const { env: e, calls } = env({});
  assert.equal(await applyPendingName(e), 'nothing-pending');
  assert.equal(calls.length, 0);
});

test('half a name is not sent, because the API requires both', async () => {
  // /api/profile/name answers 400 without both, so sending one is a request
  // that can only fail.
  for (const stored of [
    JSON.stringify({ firstName: 'Madhukar', lastName: '' }),
    JSON.stringify({ firstName: '', lastName: 'Abburi' }),
    JSON.stringify({ firstName: '   ', lastName: '  ' }),
  ]) {
    const { env: e, calls } = env({ stored });
    assert.equal(await applyPendingName(e), 'nothing-pending');
    assert.equal(calls.length, 0);
  }
});

test('a failed save keeps the name for the next attempt', async () => {
  // Losing it on a transient failure would put us back where we started, with
  // the person having typed a name that vanished.
  const { env: e, store } = env({ stored: PENDING, saveOk: false });
  assert.equal(await applyPendingName(e), 'failed');
  assert.equal(store.get(PENDING_NAME_KEY), PENDING, 'should still be there to retry');
});

test('an unreachable /api/me does not lose the name either', async () => {
  const { env: e, store } = env({ stored: PENDING, meOk: false });
  assert.equal(await applyPendingName(e), 'failed');
  assert.equal(store.get(PENDING_NAME_KEY), PENDING);
});

test('blocked site data never throws out of any of it', async () => {
  // Private browsing throws on read AND write. Signing in must still work.
  assert.doesNotThrow(() => rememberName('A', 'B', env({ throwOnSet: true }).env));
  assert.equal(await applyPendingName(env({ throwOnGet: true }).env), 'nothing-pending');

  // And a store that accepts reads but refuses deletes still saves the name.
  const { env: e } = env({ stored: PENDING, throwOnRemove: true });
  assert.equal(await applyPendingName(e), 'saved');
});

test('corrupt stored JSON is ignored rather than thrown', async () => {
  const { env: e, calls } = env({ stored: '{not json' });
  assert.equal(await applyPendingName(e), 'nothing-pending');
  assert.equal(calls.length, 0);
});

test('rememberName writes what applyPendingName reads', async () => {
  // The two halves are written apart and must agree on the shape.
  const { env: e, calls } = env({});
  rememberName('Madhukar', 'Abburi', e);
  assert.equal(await applyPendingName(e), 'saved');
  assert.deepEqual(calls.find((c) => c.url.includes('/api/profile/name'))?.body, {
    firstName: 'Madhukar',
    lastName: 'Abburi',
  });
});

test('the sign-in page stores on send and applies on landing', () => {
  const page = readFileSync(new URL('../app/signin/page.tsx', import.meta.url), 'utf8');

  // Stored only after the link was actually sent — remembering a name for a
  // request that failed would apply it on a later, unrelated sign-in.
  const send = page.slice(page.indexOf('async function send()'));
  assert.ok(
    send.indexOf('rememberName(') > send.indexOf("if (!res.ok)"),
    'the name must be remembered after the send succeeds, not before',
  );

  // Applied after the session exists, and awaited so the feed renders with the
  // name already in place.
  const landing = page.slice(page.indexOf('Completing a magic link'), page.indexOf('async function send()'));
  assert.match(landing, /await applyPendingName\(\)/);
  assert.ok(
    landing.indexOf('applyPendingName') < landing.indexOf('goToFeed()'),
    'the name must be saved before the redirect',
  );
});
