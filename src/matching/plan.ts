import { interleaveByProvider } from '../corpus/interleave.js';

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
 * fit matters, in two separate ways, and getting the second one wrong cost the
 * whole feature for a day without a single error in the log.
 *
 * BY URGENCY. A job with no vector at all has no match score, while a job whose
 * digest shifted slightly still has a usable one. So never-embedded jobs go
 * first, always, and re-embeds take whatever is left.
 *
 * BY VENDOR — and this is the one that bit. The crawl hands its jobs over sorted
 * by saturation, so taking the head of that list takes the highest-saturation
 * vendor and nothing else. Measured on the live database on 12 September 2026,
 * after the first run that embedded anything:
 *
 *   workday       31,390 open    3,415 embedded   10.9%
 *   greenhouse    13,455 open        0 embedded    0.0%
 *   ashby          5,776 open        0 embedded    0.0%
 *   ...11 others                     0 embedded    0.0%
 *
 * All 3,990 vectors were Workday. Not 47%, which is Workday's share of the
 * corpus — 100%. With 31,390 of its jobs queued ahead of them, every other
 * vendor would have waited days for a first vector, so a "best match" sort could
 * only ever have returned Workday postings. Nothing failed; the log said
 * "1,000 to send" and was telling the truth.
 *
 * So each tier is interleaved by provider before the budget is applied, which
 * hands every vendor a share proportional to the work it has. They all start
 * immediately and all finish at about the same time. See corpus/interleave.ts.
 *
 * And the count of providers is now in the log line, because the reason this
 * survived a day is that nothing printed would have looked any different if it
 * had been working.
 */

/** A job as the crawl has it, after its digest has been composed. */
export interface Candidate {
  key: string;
  digest: string;
  hash: string;
  /**
   * Which ATS it came from, for the fair-share split above.
   *
   * Required, not optional, deliberately. An optional field here would let a
   * caller omit it and silently reinstate the starvation this exists to stop —
   * and that failure is invisible at runtime, so the compiler is the only thing
   * that can be relied on to catch it.
   */
  provider: string;
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
  /**
   * How many distinct vendors are represented in `toEmbed`.
   *
   * In the log for one reason: when every vector in the database turned out to
   * belong to a single ATS, nothing in the output had looked wrong. A run that
   * covers one vendor and a run that covers fourteen are now different lines.
   */
  providers: number;
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
  //
  // Interleaved WITHIN each tier, not across the three. Urgency still outranks
  // fairness: a vendor whose jobs have no vector at all should not wait behind
  // another vendor's re-models. Spreading each tier separately keeps both
  // properties instead of trading one for the other.
  const ordered = [
    ...interleaveByProvider(missing),
    ...interleaveByProvider(changed),
    ...interleaveByProvider(remodelled),
  ];
  const cap = Math.max(0, budget);
  const toEmbed = ordered.slice(0, cap);

  return {
    toEmbed,
    unchanged,
    deferred: Math.max(0, ordered.length - cap),
    reasons: {
      missing: missing.length,
      changed: changed.length,
      remodelled: remodelled.length,
    },
    // Counted on what is actually being sent, not on what was considered. The
    // question this answers is "did this run reach more than one vendor", and
    // only the sent list can answer it.
    providers: new Set(toEmbed.map((c) => c.provider)).size,
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
  // "across N vendors" rather than a list of them: fourteen names would bury the
  // rest of the line, and the number is what anyone reads it for.
  const spread = ` across ${plan.providers} vendor${plan.providers === 1 ? '' : 's'}`;
  return `embeddings: ${plan.toEmbed.length} to send (${why})${spread}${tail}, ${plan.unchanged} unchanged`;
}
