/**
 * Turning text into a position on the map, via Cloudflare Workers AI.
 *
 * THE MODEL
 *
 * @cf/baai/bge-small-en-v1.5. Checked against Cloudflare's model page on
 * 11 Sep 2026: 384 output dimensions, 512 maximum input tokens, 1,841 Neurons
 * per million input tokens, and 10,000 free Neurons a day on every account.
 *
 * The published dollar price is $0.02 per million input tokens, which is the same
 * number from the other direction — 1,841 Neurons at $0.011 per thousand is
 * $0.0203. Two independent figures agreeing is the only reason to trust either.
 *
 * REST RATHER THAN THE WORKER BINDING
 *
 * The obvious way to call Workers AI is `env.AI.run()` from inside the Worker,
 * which needs no credentials at all. It is not usable here: the embedding has to
 * happen during the crawl, and the crawl runs on a GitHub Actions runner, not in
 * the Worker. Going through the Worker would mean a new authenticated route on a
 * Worker that already holds the Supabase service key — a larger surface than a
 * token that can do exactly one thing.
 *
 * THE FAILURE THIS FILE IS REALLY ABOUT
 *
 * One request carries many texts and the answer is an array of vectors. Nothing
 * in the response says which vector belongs to which text: the pairing is
 * position, and position alone. So if the count ever comes back short, pairing by
 * index silently attaches every vector after that point to the WRONG job — and a
 * wrong vector is invisible. The jobs still have scores, the scores are still
 * plausible numbers, and the matching is quietly nonsense.
 *
 * Hence the count and dimension checks, and hence them being errors rather than
 * warnings. There is no safe way to continue from a mismatch.
 */

export const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
export const EMBED_DIMENSIONS = 384;

/**
 * Texts per request.
 *
 * Cloudflare's documentation does not state a maximum, so this is a choice
 * rather than a limit: 50 keeps a request well under any plausible body cap,
 * keeps one failure from costing much, and at ~400 tokens a digest is ~20,000
 * tokens a call.
 */
export const EMBED_BATCH = 50;

export interface EmbedOptions {
  accountId: string;
  token: string;
  model?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
}

/** Cloudflare's envelope. `result` is the model's own output. */
interface AiResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: { shape?: number[]; data?: number[][]; pooling?: string };
}

/**
 * Worth trying again, as opposed to worth fixing.
 *
 * 429 is the daily Neuron allowance or a rate limit, and both pass. A 5xx is
 * Cloudflare having a moment. Everything else — 401, 403, 400, a missing model —
 * will say the same thing on every attempt, and retrying only delays the
 * message.
 */
function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** The specific shape of "your token cannot do this", which needs a human. */
export function isPermissionError(status: number): boolean {
  return status === 401 || status === 403;
}

export class EmbedError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** True when a person has to change something, so callers can stop early. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'EmbedError';
  }
}

/**
 * One batch of texts, in order, as one vector each.
 *
 * Returns exactly as many vectors as it was given texts, or throws. Never fewer,
 * never reordered — see the header.
 */
export async function embedBatch(
  texts: readonly string[],
  opts: EmbedOptions,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const model = opts.model ?? EMBED_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/ai/run/${model}`;

  let lastError = '';
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: [...texts] }),
      });
    } catch (err) {
      // A dropped connection is not an answer. Retry it.
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = undefined;
      if (attempt < attempts - 1) await wait(1_000 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastStatus = res.status;
      lastError = `HTTP ${res.status} ${body.slice(0, 200)}`;

      if (isPermissionError(res.status)) {
        throw new EmbedError(
          `Workers AI refused the token (HTTP ${res.status}). The token needs the ` +
            `"Workers AI: Read" permission, which a deploy-only token does not have. ${body.slice(0, 200)}`,
          res.status,
          true,
        );
      }
      if (!isTransient(res.status)) {
        throw new EmbedError(`Workers AI failed: ${lastError}`, res.status, true);
      }
      // 429 is usually the daily allowance, which does not clear in a second.
      // Backing off further buys nothing within one run, so the caller is told
      // and decides.
      if (res.status === 429) {
        throw new EmbedError(
          `Workers AI rate limited or out of daily allowance (HTTP 429). ${body.slice(0, 200)}`,
          429,
          false,
        );
      }
      if (attempt < attempts - 1) await wait(1_000 * (attempt + 1));
      continue;
    }

    const body = (await res.json().catch(() => null)) as AiResponse | null;
    if (!body) throw new EmbedError('Workers AI returned something that is not JSON', 200, true);

    if (body.success === false) {
      const why = (body.errors ?? []).map((e) => e.message ?? String(e.code)).join('; ');
      throw new EmbedError(`Workers AI reported failure: ${why || 'no reason given'}`, 200, true);
    }

    const data = body.result?.data;
    if (!Array.isArray(data)) {
      throw new EmbedError('Workers AI returned no vectors', 200, true);
    }

    // THE TWO CHECKS THIS FILE EXISTS FOR.
    //
    // Pairing is by position and nothing else, so a short answer does not mean
    // "some jobs missed out" — it means every vector after the gap is attached to
    // the wrong job, and a wrong vector looks exactly like a right one.
    if (data.length !== texts.length) {
      throw new EmbedError(
        `Workers AI returned ${data.length} vectors for ${texts.length} texts — ` +
          'pairing is positional, so this cannot be used',
        200,
        true,
      );
    }
    for (const [i, v] of data.entries()) {
      if (!Array.isArray(v) || v.length !== EMBED_DIMENSIONS) {
        throw new EmbedError(
          `vector ${i} has ${Array.isArray(v) ? v.length : 'no'} dimensions, expected ${EMBED_DIMENSIONS}`,
          200,
          true,
        );
      }
    }

    return data;
  }

  throw new EmbedError(
    `Workers AI unreachable after ${attempts} attempts: ${lastError}`,
    lastStatus,
    false,
  );
}

/**
 * A vector as Postgres wants it written.
 *
 * pgvector accepts a bracketed, comma-separated list as text and casts it. Sent
 * as a string rather than an array because PostgREST would otherwise send a JSON
 * array, which halfvec does not accept.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
