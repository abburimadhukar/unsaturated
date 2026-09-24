/**
 * How many people can hold an account on this site.
 *
 * In its own file, with no imports, so browser pages can show the number
 * without pulling supabase-js into the client bundle along with auth.ts.
 *
 * This is the number the site SAYS. The number it ENFORCES is in the database
 * trigger `enforce_seat_limit` — see src/db/migrations/2026-09-24-six-seats.sql
 * for why the cap has to live there. The two must agree: if this is higher,
 * a person is sent a sign-in link and then refused a seat when they click it;
 * if it is lower, the site says "full" while the database would have let them
 * in. seats.test.ts reads both and fails if they differ.
 *
 * 6, raised from 4 on 24 Sep 2026.
 */
export const SEAT_LIMIT = 6;
