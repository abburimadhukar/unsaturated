import type { Family } from '../taxonomy/families.js';
import { FAMILY_ORDER } from '../taxonomy/families.js';
import {
  SPECIALIZATIONS_BY_FAMILY,
  type RealFamily,
  UNKNOWN_SPECIALIZATION,
  type Specialization,
} from '../taxonomy/specializations.js';

/**
 * The filter bar's state, as pure data.
 *
 * Lifted out of the page component so the two rules that are easy to get subtly
 * wrong — clearing a specialization when the family changes, and restoring both
 * from a URL — are ordinary functions with tests, rather than behaviour buried
 * in a `useState` that can only be exercised by driving a browser.
 */

export const FILTER_DEFAULTS = {
  q: '',
  family: '',
  specialization: '',
  country: 'US',
  remote: '',
  seniority: '',
  postedWithinDays: '',
  minFit: '',
  ai: false,
  includeUnknown: true,
  employmentType: '',
  stack: '',
  // '' = core roles only, 'include' = both, 'only' = adjacent alone. Empty is
  // the default so adjacent roles never appear unasked.
  adjacent: '',
  cloudOnly: true,
  hideGhosts: true,
  hideSeen: false,
  // Browser-side, like hideSeen: the applied list belongs to the visitor, and
  // sending it would make every response unique and uncacheable.
  onlyApplied: false,
  sort: 'newest',
};

export type Filters = typeof FILTER_DEFAULTS;

/**
 * The options offered under a family, before "All" and "Unknown" are added.
 *
 * Empty for the review queue, which is not a kind of work and has no sub-types.
 * The dropdown hides itself when there is nothing to offer.
 */
export function specializationsFor(family: string): readonly Specialization[] {
  if (family === 'unsorted') return [];
  return (FAMILY_ORDER as string[]).includes(family)
    ? (SPECIALIZATIONS_BY_FAMILY[family as RealFamily] ?? [])
    : [];
}

/**
 * Whether a specialization value may be shown while `family` is selected.
 *
 * '' is "All specializations" and '__unknown__' asks for rows whose
 * specialization is NULL — both are meaningful under any family, so only a
 * concrete value from another family is rejected.
 */
export function specializationAllowed(family: string, specialization: string): boolean {
  if (specialization === '' || specialization === UNKNOWN_SPECIALIZATION) return true;
  return (specializationsFor(family) as readonly string[]).includes(specialization);
}

/**
 * Drops a specialization that no longer belongs to the selected family.
 *
 * Switching from Software to Data while `frontend` was selected would otherwise
 * leave a query the API answers with 400, and — worse, if the API were lax —
 * an empty list that reads as "there are no data jobs". Applied both when a
 * control changes and when filters arrive from a URL, because a shared link can
 * carry any combination someone typed.
 */
export function sanitizeFilters(filters: Filters): Filters {
  if (specializationAllowed(filters.family, filters.specialization)) return filters;
  return { ...filters, specialization: '' };
}

/** Applies one control's change, then re-checks the pair for consistency. */
export function applyFilterChange(
  filters: Filters,
  key: keyof Filters,
  value: string | boolean,
): Filters {
  return sanitizeFilters({ ...filters, [key]: value } as Filters);
}

/** Family buttons toggle: clicking the selected one clears it. */
export function toggleFilter(filters: Filters, key: 'family' | 'remote', value: string): Filters {
  return applyFilterChange(filters, key, filters[key] === value ? '' : value);
}

/**
 * Reads the filter set back out of a query string.
 *
 * Anything absent keeps its default, so an old link missing newer parameters
 * still opens. Anything present but nonsensical is corrected by sanitizeFilters
 * rather than passed on to the API.
 */
export function parseFilters(search: string): Filters {
  return sanitizeFilters(readFrom(FILTER_DEFAULTS, search));
}

/**
 * The same two rules, for any page that keeps its choices in the address bar.
 *
 * Quiet Roles and Institutions forgot everything on refresh — filters reset,
 * pages collapsed back to one, and a view could not be linked to or kept in a
 * tab. The feed had solved that; these two had a copy of neither half. Written
 * generically rather than copied a third time, because the pair has to agree:
 * a value that serialises one way and parses another is a filter that silently
 * turns itself off.
 */
export function readFrom<T extends Record<string, string | boolean>>(defaults: T, search: string): T {
  const p = new URLSearchParams(search);
  const out = { ...defaults } as Record<string, string | boolean>;
  for (const [k, v] of Object.entries(defaults)) {
    const raw = p.get(k);
    if (raw === null) continue;
    out[k] = typeof v === 'boolean' ? raw === '1' : raw;
  }
  return out as T;
}

export function writeTo<T extends Record<string, string | boolean>>(defaults: T, filters: T): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === (defaults as Record<string, unknown>)[k]) continue;
    p.set(k, v === true ? '1' : v === false ? '0' : String(v));
  }
  return p.toString();
}

/**
 * Quiet Roles. `family` is navigation rather than a filter, but it belongs in
 * the URL all the same — a link to the page should open on what was being
 * looked at.
 */
export const QUIET_DEFAULTS = {
  family: 'cloud',
  q: '',
  country: '',
  seniority: '',
  onSite: false,
  noEntry: false,
  midMarket: false,
  paidOnly: false,
  sort: 'newest',
};

/** Institutions. Sector is the top-level axis here, so it leads. */
export const INST_DEFAULTS = {
  sector: '',
  family: '',
  q: '',
  country: '',
  specialization: '',
  quietOnly: false,
};

export type QuietFilters = typeof QUIET_DEFAULTS;
export type InstFilters = typeof INST_DEFAULTS;

/**
 * The query string for the address bar — only what differs from the defaults,
 * so a plain visit keeps a clean URL and a shared link carries exactly the
 * choices that were made.
 */
export function serializeFilters(filters: Filters): string {
  return writeTo(FILTER_DEFAULTS, filters);
}
