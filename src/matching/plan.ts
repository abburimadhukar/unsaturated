/**
 * Which jobs to embed on this run, and which to leave alone.
 *
 * WHY THIS IS A DECISION AND NOT A LOOP
 *
 * The digest can only be built DURING a crawl. There is no `description` column
 * and there never has been — the crawler reads each body, classifies from it and
 * discards it — so a backfill pass over the database is impossible. Whatever is
 * embedded has to be embedded while the text is in memory.
 *
 * That puts the work inside the hourly crawl, which makes restraint the whole
 * problem. The crawl re-upserts every job it finds, every run: 65,818 open jobs
 * across roughly 11 runs a day. Embedding what it sees each time would be
 * 724,000 calls a day against a free allowance that covers about 43,000.
 *
 * So: embed a job once, and never again unless its digest actually changed.
 *
 * THE BUDGET, AND WHY ORDER MATTERS
 *
 * A run is capped. Whatever does not fit waits for the next one, which is fine —
 * there are eleven a day and the corpus only has to fill once. But WHICH jobs
 * fit matters: a job with no vector at all has no match score, while a job whose
 * digest shifted slightly still has a usable one. So never-embedded jobs go
 * first, always, and re-embeds take whatever is left.
 */

/** A job as the crawl has it, after its digest has been composed. */
export interface Candidate {
  key: string;
  digest: string;
  hash: string;
}

/** What the database already holds for a job. */
export interface Stored {
  hash: string;
  model: string;
}

export interface EmbeddingPlan {
  /** In the order they should be sent. */
  toEmbed: Candidate[];
  /** Already embedded from the same digest by the same model. */
  unchanged: number;
  /** Wanted embedding but did not fit the budget. Picked up next run. */
  deferred: number;
  /** Breakdown of what was chosen, for the log line. */
  reasons: { missing: number; changed: number; remodelled: number };
}

/**
 * Nothing to embed is a normal answer.
 *
 * A steady-state run finds every job unchanged and sends nothing, which is the
 * point: the cost is proportional to NEW work, not to corpus size.
 */
export function planEmbeddings(
  candidates: readonly Candidate[],
  stored: ReadonlyMap<string, Stored>,
  model: string,
  budget: number,
): EmbeddingPlan {
  const missing: Candidate[] = [];
  const changed: Candidate[] = [];
  const remodelled: Candidate[] = [];
  let unchanged = 0;

  // Deduplicated by key. A job cannot legitimately appear twice in one crawl,
  // but embedding the same thing twice costs real budget, so this is not left
  // to chance.
  const seen = new Set<string>();

  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);

    // An empty digest is not something to spend an embedding on. It cannot
    // happen for a real job — digestFor always returns at least the title, and
    // title is NOT NULL — so this is the guard for a caller that got it wrong.
    if (!c.digest.trim() || !c.hash) continue;

    const have = stored.get(c.key);
    if (!have) missing.push(c);
    else if (have.hash !== c.hash) changed.push(c);
    // A vector from one model cannot be compared with a vector from another, so
    // changing models means re-embedding rather than quietly mixing the two.
    else if (have.model !== model) remodelled.push(c);
    else unchanged++;
  }

  // Never-embedded first: those jobs currently have no score at all. A changed
  // digest still has a usable vector in the meantime, and a re-model is the
  // least urgent of the three.
  const ordered = [...missing, ...changed, ...remodelled];
  const cap = Math.max(0, budget);

  return {
    toEmbed: ordered.slice(0, cap),
    unchanged,
    deferred: Math.max(0, ordered.length - cap),
    reasons: {
      missing: missing.length,
      changed: changed.length,
      remodelled: remodelled.length,
    },
  };
}

/**
 * How the plan reads in a crawl log.
 *
 * Written as its own function because the numbers are the only way anyone will
 * know whether this is working. A run that embedded nothing and a run that was
 * throttled look identical unless the line says which.
 */
export function describePlan(plan: EmbeddingPlan): string {
  if (plan.toEmbed.length === 0 && plan.deferred === 0) {
    return `embeddings: nothing to do (${plan.unchanged} unchanged)`;
  }
  const why = [
    plan.reasons.missing ? `${plan.reasons.missing} new` : '',
    plan.reasons.changed ? `${plan.reasons.changed} changed` : '',
    plan.reasons.remodelled ? `${plan.reasons.remodelled} re-modelled` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const tail = plan.deferred > 0 ? `, ${plan.deferred} deferred to the next run` : '';
  return `embeddings: ${plan.toEmbed.length} to send (${why})${tail}, ${plan.unchanged} unchanged`;
}
