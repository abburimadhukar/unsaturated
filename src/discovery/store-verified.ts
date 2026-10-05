import { config } from '../config.js';
import type { OpenBoard } from './opendata.js';
import { summariseVerification, verifyBoards, type VerifyResult } from './verify.js';
import {
  boardIdentity,
  readActiveBoards,
  readDeliberateRetirements,
  upsertBoards,
} from '../corpus/board-store.js';
import { oracleIdFetcher, withoutOracleAliases } from './alias-guard.js';

/**
 * The shared "verify fresh candidates against the live registry, then store the
 * ones that answer" flow.
 *
 * This is the step the Hacker News harvest, the careers-page detector and the
 * open-dataset diff were all missing. Each already produced good candidates —
 * HN gives exact tokens from apply links, careers detection reads the token off
 * an employer's own page — but each wrote them to discovered-boards.json, which
 * stopped being the source of truth when the `boards` table landed. So every one
 * of those channels has contributed zero rows to the registry the crawl actually
 * reads. Routing them through here, with their own `source` label, is what wires
 * them in.
 *
 * It is the same sequence harvest-cc.ts and harvest-ia.ts run inline, factored
 * out rather than copied a third and fourth time: ask the registry what it
 * already has (never the merged crawl list — see board-store), verify only what
 * is new at one request a second, drop Oracle sites that duplicate one we hold,
 * and upsert the survivors. The two existing harvests are deliberately left as
 * they are; this helper is only used by the channels being switched on, so a
 * proven path cannot break.
 */

export interface VerifyAndStoreOptions {
  candidates: OpenBoard[];
  /**
   * Where these came from: 'hn', 'careers', 'opendata'. Stored on every row so
   * it stays possible to judge which channel is worth running — the whole reason
   * boards.source exists.
   */
  source: string;
  /** How many fresh candidates to verify this run. The rest wait for the next. */
  verifyCap?: number;
  /** Milliseconds between verification requests. Below ~1000 Greenhouse refuses. */
  delayMs?: number;
  /** Report what would be stored without writing. */
  dryRun?: boolean;
  /** Restrict to one provider, for a targeted run. */
  provider?: string;
  userAgent?: string;
  log?: (msg: string) => void;
}

export interface VerifyAndStoreResult {
  /** How many boards the registry already held. */
  registered: number;
  /** Candidates not already known. */
  fresh: number;
  /** Of the slice verified this run, how many answered live. */
  verifiedLive: number;
  /** How many rows were written (0 on a dry run). */
  stored: number;
  results: VerifyResult[];
}

/**
 * Candidates the registry does not already hold, deduplicated among themselves.
 *
 * Pure, so the filter can be tested without a database. Identity is
 * `boardIdentity` — provider, lower-cased token and Workday site — the one the
 * store itself uses, so a candidate is never called "new" and then rejected as a
 * duplicate on the way in, or vice versa.
 */
export function freshBoards(
  candidates: readonly OpenBoard[],
  known: ReadonlySet<string>,
): OpenBoard[] {
  const seen = new Set<string>();
  const out: OpenBoard[] = [];
  for (const b of candidates) {
    const id = boardIdentity(b);
    if (known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(b);
  }
  return out;
}

export async function verifyAndStore(opts: VerifyAndStoreOptions): Promise<VerifyAndStoreResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const userAgent = opts.userAgent ?? config.userAgent;
  const delayMs = opts.delayMs ?? 1000;
  const verifyCap = opts.verifyCap ?? 3000;

  // The registry, not the crawl list. "Already registered" has to mean "in the
  // registry we are about to write to" — the only definition that cannot drift.
  const registered = await readActiveBoards();
  // null means the registry could not be read. Carrying on would treat every
  // board on earth as new, re-verify thousands of them, and re-add the ones
  // deliberately retired. Stop instead.
  if (registered === null) {
    throw new Error(
      'Could not read the board registry. Refusing to verify against an unknown registry.',
    );
  }
  // Deliberately retired boards count as known too, or a duplicate retired on
  // purpose is "new" again, verifies live (it is live), and goes back to active.
  const retiredOnPurpose = await readDeliberateRetirements();
  const known = new Set([...registered, ...retiredOnPurpose].map(boardIdentity));

  let candidates = opts.candidates;
  if (opts.provider) candidates = candidates.filter((b) => b.provider === opts.provider);

  const fresh = freshBoards(candidates, known);
  log(`${known.size} already registered · ${fresh.length} not seen before`);
  if (fresh.length === 0) {
    log('Nothing new to verify.');
    return { registered: known.size, fresh: 0, verifiedLive: 0, stored: 0, results: [] };
  }

  // Verification is the slow part, so a run takes a bounded slice and the next
  // run picks up where this one stopped.
  const batch = fresh.slice(0, Math.max(0, verifyCap));
  log(
    `Verifying ${batch.length} of them at ${delayMs}ms apart ` +
      `(~${Math.round((batch.length * delayMs) / 60_000)} min).`,
  );

  const results = await verifyBoards(batch, {
    userAgent,
    delayMs,
    onResult: (_r, done, total) => {
      if (done % 25 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`);
    },
  });

  const verified = results.filter((r) => r.verdict === 'live');
  // An Oracle site that is an exact copy of one already held — or of another
  // newcomer — is not a new board. Harmless for every other provider: the guard
  // only looks at Oracle candidates.
  const { kept: live, dropped } = await withoutOracleAliases(
    verified,
    registered,
    oracleIdFetcher({ userAgent, timeoutMs: 60_000 }),
  );
  for (const d of dropped) {
    log(
      `  not storing ${d.candidate.board.token}/${d.candidate.board.extra?.site}: ` +
        `an exact copy of site ${d.copyOf}`,
    );
  }
  log('\n' + summariseVerification(results));
  log(`  jobs behind them: ${live.reduce((n, r) => n + r.jobs, 0).toLocaleString()}`);

  if (opts.dryRun) {
    log('\n--dry-run: nothing written.');
    return { registered: known.size, fresh: fresh.length, verifiedLive: live.length, stored: 0, results };
  }

  // What verification learned overrides what the candidate guessed, and only
  // where it learned something — the same rule the Common Crawl harvest uses, so
  // Oracle's opaque tokens get the employer's real name and Workday's resolved
  // shard survives into the stored row.
  const stored = await upsertBoards(
    live.map((r) => ({
      provider: r.board.provider,
      token: r.board.token,
      company: r.company ?? r.board.company,
      extra: r.extra ?? r.board.extra ?? {},
      source: opts.source,
      jobCount: r.jobs,
      ...(r.domain ? { domain: r.domain } : {}),
    })),
  );
  log(
    `\nStored ${stored} new boards (source=${opts.source}). ` +
      `${fresh.length - batch.length} still queued for a later run.`,
  );
  return { registered: known.size, fresh: fresh.length, verifiedLive: live.length, stored, results };
}
