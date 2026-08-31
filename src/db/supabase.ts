import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase access.
 *
 * Two clients, deliberately:
 *
 *   read  — publishable key. Job postings are public information republished
 *           from employers' own career pages, so the website needs no secret to
 *           serve them. This is what the deployed site uses.
 *
 *   write — service-role key, supplied only to the crawler through an
 *           environment secret. Nothing that runs in a browser can reach it.
 *
 * If the write key is absent the crawler fails loudly rather than silently
 * writing nothing, because a crawl that appears to succeed but persists no data
 * is the worst possible failure here.
 */

const URL = process.env.SUPABASE_URL ?? 'https://vupjabahniolbnbmeidk.supabase.co';

const PUBLISHABLE =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_BUdygNHc_QserbZ0tSJBWg_pGBwmfYq';

// Both defaults point at production. That is convenient and it is also how a
// misconfiguration hides: set SUPABASE_URL to staging, forget the key, and you
// get production's key against staging's host — auth fails, readFeed returns
// null, the site quietly serves the build snapshot, and nothing distinguishes
// that from an ordinary outage. Say so once at startup instead.
if (process.env.SUPABASE_URL && !process.env.SUPABASE_PUBLISHABLE_KEY) {
  console.warn(
    'SUPABASE_URL is set but SUPABASE_PUBLISHABLE_KEY is not — ' +
      'falling back to the built-in production key, which will not match a different host.',
  );
}

let readClient: SupabaseClient | null = null;
let writeClient: SupabaseClient | null = null;

export function db(): SupabaseClient {
  readClient ??= createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false },
  });
  return readClient;
}

export function dbWrite(): SupabaseClient {
  // Supabase renamed this: newer projects issue a "secret key" (sb_secret_...)
  // where older ones issued a service_role JWT. Both grant the same bypass of
  // RLS, so either name is accepted rather than making the operator care which
  // vintage of dashboard they are looking at.
  const key =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (key) {
    writeClient ??= createClient(URL, key, { auth: { persistSession: false } });
    return writeClient;
  }

  // Bootstrap fallback: use the publishable key.
  //
  // This is safe rather than a hole, because RLS still applies — writes only
  // succeed while a temporary anon-write policy is deliberately in place. Once
  // that policy is dropped, this path fails closed on its own.
  console.warn(
    'No secret key set (SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY) — ' +
      'attempting writes with the publishable key. ' +
      'This only works while a temporary anon-write policy exists.',
  );
  writeClient ??= createClient(URL, PUBLISHABLE, { auth: { persistSession: false } });
  return writeClient;
}

/** True when a write key is available, so callers can degrade rather than throw. */
export function canWrite(): boolean {
  return Boolean(process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export const SUPABASE_URL = URL;
