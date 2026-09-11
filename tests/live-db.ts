import { db } from '../src/db/supabase.js';
import { facetsFromDb } from '../src/corpus/db-query.js';
import { isTransientWriteError } from '../src/corpus/db-feed.js';

/**
 * Whether the live-database tests may run, and an honest reason when they may not.
 *
 * WHY THIS EXISTS
 *
 * `tests/feed-route.test.ts` is the only file here that queries the production
 * database. It pages through every open posting — 67,000 of them on 10 Sep 2026,
 * over roughly 125 sequential requests — while hourly crawls write to the same
 * table. So it is a health check wearing a unit test's clothes, and `npm test`
 * could not tell a broken change from a moved number. Four consecutive runs on
 * 10 Sep, with identical code:
 *
 *   25 pass  0 fail
 *   24 pass  1 fail
 *    9 pass  0 fail   (probe returned null, so all 25 skipped)
 *   18 pass  7 fail
 *
 * THE DIAGNOSIS IT USED TO PRINT WAS WRONG
 *
 * `facetsFromDb` logs and returns null for EVERY failure — a timeout and a
 * missing column look identical to a caller. The old probe read that null and
 * concluded:
 *
 *   "feed_facets does not accept p_specialization yet — apply the migration"
 *
 * which sends someone off to apply a migration that is already applied. Called
 * six times in a row by hand it answered correctly every time in 446-752ms; it
 * returns null under load, not because of the schema.
 *
 * That is the same mistake as the crawl bug fixed in the commit before this one:
 * a transient refusal read as a permanent fault.
 *
 * SO THE PROBE ASKS TWO QUESTIONS IN ORDER
 *
 *   1. Can we reach the database at all? A trivial select that depends on no
 *      migration. Retried, because this is the question that gets a transient no.
 *   2. Only if yes — does feed_facets accept the call? A null HERE means the
 *      database is answering and the RPC still refused, which is a fair basis for
 *      naming the schema.
 *
 * Splitting them is the whole point: question 1 failing is "come back later",
 * question 2 failing is "there is work to do". They are not the same sentence.
 */
export interface LiveDbStatus {
  ok: boolean;
  reason: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set LIVE_DB=1 to opt in. `npm run test:live` does it for you. */
export const LIVE_DB_ENABLED = process.env.LIVE_DB === '1';

export async function checkLiveDb(attempts = 3): Promise<LiveDbStatus> {
  // Opt-in, so `npm test` is deterministic and safe to gate a commit on.
  // Without this, a busy database or a crawl mid-write turns a green suite red
  // and the signal stops meaning anything.
  if (!LIVE_DB_ENABLED) {
    return { ok: false, reason: 'live-database tests are opt-in — run `npm run test:live`' };
  }

  // 1. Reachability. `jobs` has existed since the first schema, so this question
  //    cannot be confused with a missing migration.
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    const { error } = await db().from('jobs').select('key').limit(1);
    if (!error) {
      lastError = '';
      break;
    }
    lastError = error.message;
    // Only wait if it is worth waiting for. A permissions or schema error will
    // say the same thing three times.
    if (!isTransientWriteError(error.message)) break;
    await sleep(500 * (i + 1));
  }
  if (lastError) {
    return {
      ok: false,
      reason: isTransientWriteError(lastError)
        ? `database busy after ${attempts} attempts (transient, not a schema problem): ${lastError}`
        : `database unreachable: ${lastError}`,
    };
  }

  // 2. The migration. The database is answering, so a refusal here is about the
  //    RPC rather than the connection — but retried anyway, because one busy
  //    moment is not evidence about a schema.
  for (let i = 0; i < attempts; i++) {
    const facets = await facetsFromDb({ specialization: 'backend' });
    if (facets && typeof facets.specialization === 'object') {
      return { ok: true, reason: '' };
    }
    if (i < attempts - 1) await sleep(500 * (i + 1));
  }

  return {
    ok: false,
    reason:
      `the database is reachable but feed_facets refused ${attempts} times — ` +
      'most likely p_specialization is missing, so apply the migration. ' +
      '(facetsFromDb returns null for every failure, so this cannot be narrowed further here.)',
  };
}
