/**
 * Two addresses for one board, told apart from two boards that look alike.
 *
 * An Oracle tenant can run several career sites, and the registry keeps each as
 * its own row — which is right when they differ and wasteful when they do not.
 * Oracle serves a default site, `CX`, that is very often the same requisition
 * pool as the tenant's named one: measured 16 September 2026, eofh/CX and
 * eofh/CX_3001 (Tata Capital) returned 5,265 postings with identical ids, as did
 * ibnjjb/CX and ibnjjb/CX_1 (Lifepoint Health). 156 tenants held 381 site rows.
 *
 * Crawling both reads every posting twice. It stores nothing twice — a job key is
 * provider:token:id and the site is not in it — so the cost is crawl time and
 * database load, not wrong data. That is why the bar for calling two sites one
 * board is total, not statistical: EVERY id must match. emit/CX and emit/CX_2001
 * (WSP) share their first page and differ by seventeen postings; they are two
 * boards and both stay.
 */

/** A site, reduced to what decides whether it is the same board as another. */
export interface SiteIds {
  site: string;
  ids: ReadonlySet<string>;
}

/**
 * The prefix a deliberate alias retirement is recorded under.
 *
 * Read by revival.ts, which must never bring one back: a revived alias is
 * crawled twice again, which is the whole thing being undone.
 */
export const ALIAS_PREFIX = 'duplicate site of ';

export function aliasReason(keptSite: string): string {
  return `${ALIAS_PREFIX}${keptSite} — identical postings, every id compared`;
}

/** Whether two sites carry exactly the same postings. An empty site matches nothing. */
export function sameBoard(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Which of several identical sites to keep.
 *
 * Oracle's `CX` is the tenant's default address, and its own UI redirects it to
 * the named site (hccz/CX lands on CX_2). The named site is the canonical one,
 * so it is kept and `CX` is the alias. Among named sites the choice is
 * arbitrary, so it is made stable — alphabetical — so two runs never disagree.
 */
export function pickKeeper(sites: readonly string[]): string {
  const named = sites.filter((s) => s.toUpperCase() !== 'CX');
  const pool = named.length > 0 ? named : [...sites];
  return [...pool].sort((x, y) => x.localeCompare(y))[0]!;
}

/**
 * Groups a tenant's sites into boards and names the rows to retire.
 *
 * Returns only the sites that are an exact copy of a kept one. A site that
 * matches nothing, or could not be read (an empty set), is never in the answer —
 * failing to read a site is not evidence that it duplicates another.
 */
export function aliasesOf(sites: readonly SiteIds[]): { site: string; keptSite: string }[] {
  const groups: SiteIds[][] = [];
  for (const s of sites) {
    if (s.ids.size === 0) continue;
    const home = groups.find((g) => sameBoard(g[0]!.ids, s.ids));
    if (home) home.push(s);
    else groups.push([s]);
  }

  const out: { site: string; keptSite: string }[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const keptSite = pickKeeper(g.map((s) => s.site));
    for (const s of g) if (s.site !== keptSite) out.push({ site: s.site, keptSite });
  }
  return out;
}
