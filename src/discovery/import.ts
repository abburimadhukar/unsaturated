import { getAdapter } from '../ats/adapters/index.js';
import type { BoardRef } from '../ats/types.js';
import { config } from '../config.js';

/**
 * Validates boards whose token is already known.
 *
 * Distinct from the name-prober: that one guesses up to fifteen slug variants
 * per company because it only has a company name. When the token comes from a
 * source that published it — an apply link in an HN thread — one request
 * settles it. Roughly fifteen times cheaper, and far politer to the providers.
 */

export interface ValidatedBoard {
  provider: string;
  token: string;
  company: string;
  jobCount: number;
  extra?: Record<string, string>;
}

export interface ImportStats {
  tried: number;
  valid: ValidatedBoard[];
  empty: string[];
  failed: string[];
}

/**
 * Recovers a real company name from a returned posting.
 *
 * Several providers echo the employer name in their payload, which is far better
 * than a prettified token — "duck-duck-go" versus "DuckDuckGo".
 */
function companyFromRaw(raw: unknown): string | undefined {
  const r = raw as Record<string, unknown> | undefined;
  if (!r) return undefined;

  const direct = r['company_name'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const nested = r['company'];
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  if (nested && typeof nested === 'object') {
    const name = (nested as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return undefined;
}

/** "duck-duck-go" -> "Duck Duck Go". Fallback when the payload names nobody. */
function prettifyToken(token: string): string {
  return token
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function validateOne(ref: BoardRef): Promise<ValidatedBoard | 'empty' | 'failed'> {
  try {
    const jobs = await getAdapter(ref.provider).fetchJobs(ref, {
      userAgent: config.userAgent,
      timeoutMs: 15_000,
      // One posting is enough to prove the board exists and is publishing.
      maxJobs: 1,
    });
    if (jobs.length === 0) return 'empty';

    const company = companyFromRaw(jobs[0]?.raw) ?? prettifyToken(ref.token);
    const out: ValidatedBoard = {
      provider: ref.provider,
      token: ref.token,
      company,
      jobCount: jobs.length,
    };
    if (ref.extra) out.extra = ref.extra;
    return out;
  } catch {
    return 'failed';
  }
}

export async function importBoards(
  refs: BoardRef[],
  concurrency = 6,
  onProgress?: (done: number, total: number, valid: number) => void,
): Promise<ImportStats> {
  const stats: ImportStats = { tried: refs.length, valid: [], empty: [], failed: [] };
  let cursor = 0;
  let done = 0;

  const workers = Array.from({ length: Math.min(concurrency, refs.length) }, async () => {
    while (cursor < refs.length) {
      const ref = refs[cursor++];
      if (!ref) break;

      const result = await validateOne(ref);
      const label = `${ref.provider}:${ref.token}`;
      if (result === 'empty') stats.empty.push(label);
      else if (result === 'failed') stats.failed.push(label);
      else stats.valid.push(result);

      done++;
      onProgress?.(done, refs.length, stats.valid.length);
      if (config.delayMs > 0) await sleep(config.delayMs);
    }
  });

  await Promise.all(workers);
  return stats;
}
