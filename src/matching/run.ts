import { EMBED_BATCH, EMBED_MODEL, EmbedError, embedBatch } from './embed.js';
import { describePlan, planEmbeddings, type Candidate } from './plan.js';
import { readStoredHashes, writeEmbeddings, type EmbeddingRow, type StoreOptions } from './store.js';

/**
 * Filling the map, as one step of a crawl.
 *
 * THE ONE RULE THIS FILE OBEYS
 *
 * It cannot fail the crawl. By the time it runs, ~16,000 postings have already
 * been written and the run's real work is done. An embedding is an enhancement:
 * a job without one loses its match score until the next of eleven daily runs,
 * while a thrown error loses every posting the crawl collected. That trade is
 * never worth making, so everything here is caught and reported.
 *
 * WHY IT NEEDS NO CREDENTIALS TO BE PRESENT
 *
 * Without CLOUDFLARE_ACCOUNT_ID and a token it says so once and does nothing.
 * The crawl is the product; this is new and must be switchable off by simply not
 * configuring it — including on a contributor's laptop, which has neither.
 */

export interface RunOptions extends StoreOptions {
  accountId?: string | undefined;
  token?: string | undefined;
  model?: string;
  /**
   * Embeddings per run.
   *
   * The free allowance is 10,000 Neurons a day and a digest is ~400 tokens, so
   * at 1,841 Neurons per million tokens a day covers roughly 13,500 digests.
   * Across eleven runs that is ~1,200 each, and 1,000 leaves room for the
   * resume embeddings and for being wrong about the token ratio.
   *
   * The corpus fills in about a week at that rate. Going faster risks spending
   * the whole allowance in one run and leaving the rest of the day unable to
   * embed anything new, which is worse than taking a week once.
   */
  budget?: number;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

export interface RunResult {
  /** Vectors written to the database. */
  embedded: number;
  /** Already current, so not sent. */
  unchanged: number;
  /** Wanted embedding but did not fit this run's budget. */
  deferred: number;
  /** One line for the crawl log. Always present, even on failure. */
  note: string;
  /** True when a person has to do something before this can work. */
  needsAttention: boolean;
}

const DEFAULT_BUDGET = 1_000;

/** A job as the crawl has it: in scope, with a digest composed in live.ts. */
export interface EmbeddableJob {
  key: string;
  matchDigest?: string | undefined;
  matchHash?: string | undefined;
}

/**
 * Embeds what needs embedding, and reports what it did.
 *
 * Returns rather than throws in every case, including a missing token and a
 * refused one — see the rule at the top.
 */
export async function embedNewJobs(
  jobs: readonly EmbeddableJob[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const idle: RunResult = {
    embedded: 0, unchanged: 0, deferred: 0, note: '', needsAttention: false,
  };

  const accountId = opts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = opts.token ?? process.env.CLOUDFLARE_AI_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    return {
      ...idle,
      note: 'embeddings: skipped, no CLOUDFLARE_ACCOUNT_ID / token configured',
    };
  }

  const model = opts.model ?? EMBED_MODEL;
  const budget = opts.budget ?? DEFAULT_BUDGET;

  // Only jobs that actually have a digest. A posting with none is either out of
  // scope or had no title to compose from, and neither is worth a call.
  const candidates: Candidate[] = [];
  for (const j of jobs) {
    if (j.matchDigest && j.matchHash) {
      candidates.push({ key: j.key, digest: j.matchDigest, hash: j.matchHash });
    }
  }
  if (candidates.length === 0) return { ...idle, note: 'embeddings: nothing in scope this run' };

  try {
    const stored = await readStoredHashes(
      candidates.map((c) => c.key),
      opts,
    );
    const plan = planEmbeddings(candidates, stored, model, budget);
    if (plan.toEmbed.length === 0) {
      return { ...idle, unchanged: plan.unchanged, deferred: plan.deferred, note: describePlan(plan) };
    }

    let embedded = 0;
    let stoppedEarly = '';

    for (let i = 0; i < plan.toEmbed.length; i += EMBED_BATCH) {
      const batch = plan.toEmbed.slice(i, i + EMBED_BATCH);
      let vectors: number[][];
      try {
        vectors = await embedBatch(
          batch.map((c) => c.digest),
          {
            accountId,
            token,
            model,
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            ...(opts.wait ? { wait: opts.wait } : {}),
          },
        );
      } catch (err) {
        // A permission problem or a spent allowance applies to every remaining
        // batch too, so there is nothing to gain by working through them. Stop,
        // keep what already landed, and say why.
        const e = err instanceof EmbedError ? err : null;
        stoppedEarly = e ? e.message : err instanceof Error ? err.message : String(err);
        return {
          embedded,
          unchanged: plan.unchanged,
          deferred: plan.deferred + (plan.toEmbed.length - i),
          note: `embeddings: stopped after ${embedded} — ${stoppedEarly}`,
          needsAttention: e?.permanent === true,
        };
      }

      // Paired by position, which embedBatch has already refused to return
      // unless the counts match — so this zip is safe because that check exists.
      const rows: EmbeddingRow[] = batch.map((c, n) => ({
        jobKey: c.key,
        vector: vectors[n]!,
        model,
        sourceHash: c.hash,
      }));
      embedded += await writeEmbeddings(rows, opts);
    }

    return {
      embedded,
      unchanged: plan.unchanged,
      deferred: plan.deferred,
      note: `${describePlan(plan)}; ${embedded} written`,
      needsAttention: false,
    };
  } catch (err) {
    // Anything unforeseen. The postings are already saved; this is the line that
    // keeps a surprise here from costing the run.
    return {
      ...idle,
      note: `embeddings: failed — ${err instanceof Error ? err.message : String(err)}`,
      needsAttention: false,
    };
  }
}
