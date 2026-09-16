import { getAdapter } from '../ats/adapters/index.js';
import type { BoardRef, FetchContext } from '../ats/types.js';
import { aliasesOf, sameBoard } from './aliases.js';
import type { OpenBoard } from './opendata.js';

/**
 * Keeps discovery from registering an Oracle site that duplicates one it has.
 *
 * Retiring the existing copies is not enough on its own. Discovery compares
 * candidates against ACTIVE boards only, so a retired copy looks brand new the
 * next Sunday, verifies live — it is live — and would be upserted straight back
 * to active. And a tenant discovered for the first time arrives with its `CX`
 * alias and its named site together.
 *
 * So before anything is stored, a candidate site of a tenant that already has a
 * site, or that arrives with a sibling, is compared id for id. It is dropped
 * only on an exact match. Existing rows are never changed here — retiring them
 * is `oracle-aliases`, which a person reads before it is applied.
 */

export type FetchIds = (board: BoardRef) => Promise<ReadonlySet<string>>;

/** Every posting id a site carries, or an empty set when it cannot be read. */
export function oracleIdFetcher(ctx: FetchContext): FetchIds {
  const adapter = getAdapter('oracle');
  return async (board) => {
    try {
      return new Set((await adapter.fetchJobs(board, ctx)).map((j) => j.externalId));
    } catch {
      // Empty matches nothing, so a site that will not answer is never called
      // a copy of anything.
      return new Set();
    }
  };
}

const tenantOf = (b: { token: string }) => b.token.toLowerCase();
const siteOf = (b: { extra?: Record<string, string> }) => b.extra?.site ?? '';

export async function withoutOracleAliases<T extends { board: OpenBoard }>(
  live: readonly T[],
  registered: readonly { provider: string; token: string; extra?: Record<string, string> }[],
  fetchIds: FetchIds,
): Promise<{ kept: T[]; dropped: { candidate: T; copyOf: string }[] }> {
  const existing = new Map<string, BoardRef[]>();
  for (const r of registered) {
    if (r.provider !== 'oracle') continue;
    const t = tenantOf(r);
    existing.set(t, [...(existing.get(t) ?? []), { provider: 'oracle', token: r.token, extra: r.extra ?? {} }]);
  }

  const candidatesByTenant = new Map<string, T[]>();
  for (const c of live) {
    if (c.board.provider !== 'oracle') continue;
    const t = tenantOf(c.board);
    candidatesByTenant.set(t, [...(candidatesByTenant.get(t) ?? []), c]);
  }

  const drop = new Map<T, string>();
  for (const [tenant, candidates] of candidatesByTenant) {
    const have = existing.get(tenant) ?? [];
    if (have.length + candidates.length < 2) continue;

    const haveIds = await Promise.all(have.map(async (b) => ({ site: siteOf(b), ids: await fetchIds(b) })));
    const candIds = await Promise.all(
      candidates.map(async (c) => ({ c, site: siteOf(c.board), ids: await fetchIds(c.board) })),
    );

    // A copy of something already registered goes, whatever its name.
    const remaining: typeof candIds = [];
    for (const x of candIds) {
      const twin = haveIds.find((h) => sameBoard(h.ids, x.ids));
      if (twin) drop.set(x.c, twin.site);
      else remaining.push(x);
    }

    // Copies among the newcomers themselves: keep one, by the same rule the
    // retirement pass uses, so the two never disagree about which survives.
    for (const a of aliasesOf(remaining.map(({ site, ids }) => ({ site, ids })))) {
      const x = remaining.find((r) => r.site === a.site);
      if (x) drop.set(x.c, a.keptSite);
    }
  }

  return {
    kept: live.filter((c) => !drop.has(c)),
    dropped: [...drop].map(([candidate, copyOf]) => ({ candidate, copyOf })),
  };
}
