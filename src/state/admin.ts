/**
 * Who may see everyone else's activity.
 *
 * A hardcoded list of addresses, checked on the SERVER against the verified
 * session — never a flag in the response that the browser could set, and never
 * a query parameter. The whole value of an admin view is that ordinary users
 * cannot reach it, and the only thing standing between the two is this check,
 * so it lives in one place and is tested.
 *
 * Read from the environment where one is set, so the list can change without a
 * deploy, and defaulting to the site owner otherwise.
 */

const DEFAULT_ADMINS = ['abburimadhukar1@gmail.com'];

export function adminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS;
  const list = raw
    ? raw.split(',').map((e) => e.trim()).filter(Boolean)
    : DEFAULT_ADMINS;
  // Addresses are compared case-insensitively: nobody thinks of their own email
  // as case-sensitive, and a capital letter in a sign-in form must not silently
  // revoke access.
  return list.map((e) => e.toLowerCase());
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}
