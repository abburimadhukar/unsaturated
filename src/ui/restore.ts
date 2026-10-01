/**
 * Remembering a list page's place across a trip to another page and back.
 *
 * The Quiet Roles and Institutions pages page by growing a `shown` count and
 * hold their filters in the URL, but they kept no memory of how far you had
 * scrolled or how many pages you had opened. So clicking "After applying" and
 * coming back — or a refresh — dropped you at the top of the first page every
 * time. The main feed already solved this inline; this is the same idea, shared,
 * so the two secondary pages behave the same way without copying the logic twice.
 *
 * Keyed by a per-page string so the three lists never read each other's place,
 * and matched by the full query string so returning to a DIFFERENT filter set
 * correctly starts fresh rather than restoring a position that no longer exists.
 *
 * Every read and write is wrapped: private browsing and blocked site data both
 * throw on sessionStorage, and a lost scroll position must never break the page.
 */

export interface Restorable {
  /** The `shown` count at the moment the page was left, so "show more" survives. */
  shown: number;
  scrollY: number;
  /** The URL query the position belongs to; a different one starts fresh. */
  search: string;
}

export function readRestorable(key: string): Restorable | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Restorable) : null;
  } catch {
    return null;
  }
}

export function writeRestorable(key: string, value: Restorable): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or blocked site data — the page still works, the position
    // is just not remembered.
  }
}

/**
 * The `shown` count a page should start at: the saved one when returning to the
 * very same view, otherwise the default first page. Capped so a restore never
 * asks for more than one request's worth of rows.
 */
export function initialShown(key: string, page: number, max = 200): number {
  if (typeof window === 'undefined') return page;
  const saved = readRestorable(key);
  if (saved && saved.search === window.location.search && saved.shown > page) {
    return Math.min(saved.shown, max);
  }
  return page;
}

/**
 * The saved scroll position to restore for this exact view, or 0 if there is
 * nothing to restore (a fresh view, a different filter set, or no saved state).
 */
export function savedScrollY(key: string): number {
  if (typeof window === 'undefined') return 0;
  const saved = readRestorable(key);
  if (saved && saved.search === window.location.search && saved.scrollY > 0) {
    return saved.scrollY;
  }
  return 0;
}
