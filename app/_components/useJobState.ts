'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Which jobs this visitor has seen or opened, for the pages that use the shared
 * JobCard (Quiet Roles and Institutions).
 *
 * The main feed tracks this inline off /api/me; these two pages had no marking at
 * all, so opening a role from them left no trace and the card never dimmed. This
 * is the same behaviour, shared: it reads the seen/applied sets from /api/state
 * (lighter than /api/me — it is only the job marks, not the resume) and marks a
 * job applied when its posting is opened.
 *
 * The mark is OPTIMISTIC: the card dims the instant you click, rather than after a
 * round trip, which is what makes "I already looked at that one" feel immediate.
 * If the write fails the optimistic mark simply stands for the session; it is not
 * invented data in the database, and the next load reflects the truth.
 *
 * Scoped to the caller by /api/state itself (a visitor cookie or a signed-in
 * session), so this works whether or not someone has signed in.
 */
export function useJobState() {
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [applied, setApplied] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const body = (await res.json()) as { seen?: string[]; applied?: string[] };
      setSeen(new Set(body.seen ?? []));
      setApplied(new Set(body.applied ?? []));
    } catch {
      // Network trouble: leave whatever we have. A missing mark only means a card
      // that does not dim, never a broken page.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markApplied = useCallback((key: string) => {
    // Dim immediately, then tell the server. Opening a posting implies seeing it,
    // exactly as the main feed and the store treat it.
    setSeen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setApplied((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    void fetch('/api/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, action: 'applied' }),
    }).catch(() => {
      // Swallowed on purpose: the optimistic mark stands for the session, and a
      // later refresh corrects it if the write really did not land.
    });
  }, []);

  return { seen, applied, markApplied };
}
