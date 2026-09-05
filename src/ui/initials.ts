/**
 * The two letters shown in the avatar.
 *
 * Never the first two letters of an email address. "ab" from
 * abburimadhukar@… reads as initials and is not — it is the start of a
 * username, and showing it would make an unnamed account look named.
 */
export function initialsOf(first: string | null, last: string | null, email: string): string {
  const a = (first ?? '').trim();
  const b = (last ?? '').trim();
  if (a || b) return ((a[0] ?? '') + (b[0] ?? '')).toUpperCase();
  return (email[0] ?? '?').toUpperCase();
}
