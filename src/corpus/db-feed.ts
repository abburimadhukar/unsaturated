import { db, dbWrite } from '../db/supabase.js';
import type { AtsProvider } from '../ats/types.js';
import type { Family } from '../taxonomy/families.js';
import type { Specialization } from '../taxonomy/specializations.js';
import { MAX_AGE_DAYS, type Feed, type FeedJob } from './live.js';

/**
 * Reads the corpus from Supabase and writes crawl results back to it.
 *
 * The read returns the same `Feed` shape the in-memory path produces, so every
 * filter, facet and sort already built and tested keeps working untouched — the
 * database is a storage swap, not a rewrite.
 */

export interface JobRow {
  key: string;
  provider: string;
  board_token: string;
  company: string;
  title: string;
  location: string | null;
  country: string | null;
  remote_type: string | null;
  seniority: string | null;
  employment_type: string | null;
  department: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  posted_at: string | null;
  apply_url: string | null;
  family: string | null;
  adjacent?: boolean | null;
  sector?: string | null;
  specialization: string | null;
  specialization_reason?: string | null;
  classification_version?: string | null;
  ai: boolean;
  matched_skills: string[] | null;
  skill_score: number | null;
  ghost_risk: number | null;
}

/** Supabase caps a single select at 1000 rows, so reads are paged. */
const PAGE = 1000;

/**
 * How many keys may go into one `.in(...)` filter.
 *
 * An upsert sends its rows in the request BODY, so 500 at a time is fine there.
 * A filter is different: PostgREST puts `key=in.(...)` in the query string, and
 * the request line has a hard 16 KB ceiling. Job keys average 51 characters, so
 * 500 of them build a ~29 KB URL and the server answers 400 Bad Request.
 *
 * That is not hypothetical. Every close pass on every shard failed this way,
 * every hour: "close failed for 500 jobs: Bad Request", four times per crawl.
 * The measured boundary from those logs is between 210 keys (~12 KB, succeeded)
 * and 341 (~20 KB, failed).
 *
 * The damage was worse than a retry would suggest, because the stale list is
 * ordered by key: the SAME leading 500 failed on every run forever, so those
 * postings could never close, however many times the crawl ran. Only the short
 * final chunk ever got through.
 *
 * 150, sized against the WORST case rather than the average. Keys average 51
 * characters, but the longest in the corpus is 69 and each carries two colons
 * that percent-encode to three bytes apiece. At 200 the pessimistic bound lands
 * at ~16.5 KB — over the line, and only the average kept it working. 150 leaves
 * ~12.4 KB even if every key is the longest one, and the extra round trips cost
 * nothing: a run closes a few hundred postings, not a few hundred thousand.
 */
const FILTER_CHUNK = 150;

/** Closed jobs older than this are deleted outright. */
const PURGE_AFTER_DAYS = 45;

export function toFeedJob(r: JobRow, now: number = Date.now()): FeedJob {
  const postedMs = r.posted_at ? Date.parse(r.posted_at) : NaN;
  const ageDays = Number.isFinite(postedMs)
    // Floor, not round: rounding made "today" cover only the first 12 hours,
    // called a 30-hour-old posting "yesterday", and let "posted within 24
    // hours" admit anything up to 36 hours old.
    ? Math.floor((now - postedMs) / 86_400_000)
    : null;

  return {
    key: r.key,
    title: r.title,
    company: r.company,
    provider: r.provider as AtsProvider,
    location: r.location,
    country: r.country,
    remoteType: r.remote_type,
    seniority: r.seniority,
    employmentType: r.employment_type,
    department: r.department,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    salaryCurrency: r.salary_currency,
    postedAt: r.posted_at,
    ageDays,
    applyUrl: r.apply_url,
    // Only ghost risk is still consumed by the UI; the rest of the scoring
    // breakdown was removed when ranking moved to recency.
    components: { ghostRisk: r.ghost_risk ?? 0 },
    reasons: [],
    // Retained on the type for compatibility with the snapshot path; the UI
    // stopped displaying it when ranking moved to recency.
    saturation: 0,
    inScope: r.family !== null,
    family: (r.family as Family | null) ?? null,
    adjacent: r.adjacent === true,
    sector: r.sector ?? null,
    // Null is a value here, not a gap: the family is known and the kind of job
    // is not. The UI says so rather than picking one.
    specialization: (r.specialization as Specialization | null) ?? null,
    // Spread rather than assigned, so the keys are absent instead of null when
    // the row did not carry them. feed_page strips both from the page it
    // returns — they are classifier debugging, and this response is CDN-cached
    // and read by a browser that displays neither — and `?? null` was putting
    // the empty keys back on every one of the 50 rows.
    ...(r.specialization_reason != null ? { specializationReason: r.specialization_reason } : {}),
    ...(r.classification_version != null ? { classificationVersion: r.classification_version } : {}),
    ai: r.ai ?? false,
    matchedSkills: r.matched_skills ?? [],
    skillScore: r.skill_score ?? 0,
  };
}

/** A database not being refreshed must not shadow a fresher build snapshot. */
const MAX_DB_STALENESS_MS = 6 * 60 * 60 * 1000;

export async function readFeed(): Promise<Feed | null> {
  const client = db();
  const now = Date.now();
  const cutoff = new Date(now - MAX_AGE_DAYS * 86_400_000).toISOString();

  // If the crawler has stopped writing — for instance because the service-role
  // key is missing — the rows here are frozen while the build snapshot keeps
  // updating. Returning null hands over to that fresher source instead of
  // serving old jobs from a table nobody is maintaining.
  const { data: runs } = await client
    .from('crawl_runs')
    .select('finished_at,jobs_scanned')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1);
  const lastRun = runs?.[0]?.finished_at as string | undefined;
  // The jobs table holds only classified roles, so its row count is not the
  // crawl size. The run record carries the real figure.
  const scannedTotal = (runs?.[0] as { jobs_scanned?: number } | undefined)?.jobs_scanned;
  if (!lastRun || now - Date.parse(lastRun) > MAX_DB_STALENESS_MS) {
    return null;
  }

  const rows: JobRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('jobs')
      .select(
        'key,provider,board_token,company,title,location,country,remote_type,seniority,' +
          'employment_type,department,salary_min,salary_max,salary_currency,posted_at,apply_url,family,' +
          'adjacent,sector,specialization,specialization_reason,classification_version,ai,' +
          'matched_skills,skill_score,ghost_risk',
      )
      .is('closed_at', null)
      .not('family', 'is', null)
      // Undated postings are kept: several providers omit a publish date, and
      // excluding them would silently drop those boards entirely.
      // Undated postings are kept — several providers omit a publish date, and
      // excluding them would drop those boards entirely — but they still have to
      // expire, or a Rippling posting sitting on the board for a year is served
      // as current inventory forever. first_seen_at is when WE first stored it,
      // which is a fact we own rather than a date we invented.
      .or(`posted_at.gte.${cutoff},and(posted_at.is.null,first_seen_at.gte.${cutoff})`)
      .order('posted_at', { ascending: false, nullsFirst: false })
      // Tiebreaker. posted_at is heavily non-unique — ATS feeds stamp a whole
      // board at once — and Postgres gives no stable order within a tie, so
      // paging could duplicate or skip rows whose page boundary fell inside one.
      .order('key', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      // A database problem must not take the site down — the caller falls back
      // to the build-time snapshot.
      console.error('supabase read failed:', error.message);
      return null;
    }
    const batch = (data ?? []) as unknown as JobRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  if (rows.length === 0) return null;

  const { count } = await client
    .from('jobs')
    .select('key', { count: 'exact', head: true })
    .is('closed_at', null);

  return {
    jobs: rows.map((r) => toFeedJob(r, now)),
    boards: [],
    refreshedAt: lastRun,
    source: 'live',
    scanned: scannedTotal ?? count ?? rows.length,
  };
}

/**
 * A FeedJob as the `jobs` table wants it.
 *
 * Extracted from writeFeed so it can be tested. It was inline, and one crawl
 * stored 11,491 unsorted rows and zero adjacent ones because `adjacent` was
 * simply missing from the object literal: the flag was computed, carried
 * through the whole pipeline, and then never written. Nothing failed — the
 * column was absent from the payload, so every row silently took its default.
 *
 * A field dropped here is invisible at every other layer, which is exactly why
 * this needs to be a function with a test rather than a literal buried in a
 * hundred-line write path.
 */
export function toJobRow(j: FeedJob, now: string = new Date().toISOString()) {
  return {
    key: j.key,
    provider: j.provider,
    board_token: j.key.split(':')[1] ?? '',
    company: j.company,
    title: j.title,
    location: j.location,
    country: j.country,
    remote_type: j.remoteType,
    seniority: j.seniority,
    employment_type: j.employmentType,
    department: j.department,
    salary_min: j.salaryMin,
    salary_max: j.salaryMax,
    salary_currency: j.salaryCurrency,
    posted_at: j.postedAt,
    apply_url: j.applyUrl,
    family: j.family,
    // Absent from this mapping for one crawl, which is why that run stored
    // 11,491 unsorted rows and zero adjacent ones: the flag was computed in
    // memory, carried through the whole pipeline, and then simply not written.
    // Nothing failed — the column just never appeared in the payload, so every
    // row took the default of false.
    adjacent: j.adjacent === true,
    sector: j.sector ?? null,
    specialization: j.specialization,
    specialization_reason: j.specializationReason ?? null,
    classification_version: j.classificationVersion ?? null,
    ai: j.ai,
    matched_skills: j.matchedSkills,
    skill_score: j.skillScore,
    ghost_risk: j.components.ghostRisk ?? 0,
    last_seen_at: now,
    closed_at: null,
  };
}

/**
 * Writes a completed crawl to the database.
 *
 * Upserts every job seen, then closes anything on those boards that stopped
 * appearing. Closing is scoped to boards that actually returned results, so a
 * board erroring out never marks its whole catalogue as gone.
 */

/**
 * Errors worth retrying smaller rather than giving up on.
 *
 * A statement timeout is not a bad row — it is one statement that asked for
 * more than the database would give it in the time allowed. Four shards upsert
 * into `jobs` at once, and the table carries a stored generated column plus
 * several indexes, so a 500-row statement can genuinely run long under
 * contention while a 250-row one sails through.
 *
 * Matched narrowly. A constraint violation or a missing column is a real fault
 * and must still fail loudly on the first attempt.
 */
export function isTransientWriteError(message: string): boolean {
  return TRANSIENT.test(message);
}

/**
 * "Too busy right now", in every phrasing this project has actually been told.
 *
 * Two different layers refuse us and they word it differently. Postgres kills a
 * query: `canceling statement due to statement timeout`. The HTTP gateway in
 * front of Postgres gives up waiting on one: `Gateway Timeout`. Same cause, same
 * correct response — ask for less — and only the first was on this list.
 *
 * That gap cost a whole shard on 8 Sep 2026. It had crawled for thirteen minutes
 * and collected ~16,000 roles:
 *
 *   crawl failed: supabase upsert failed: Gateway Timeout
 *
 * The halving retry was right there and never fired, because the string did not
 * match. Four of the crawl failures on record are this one shape — a transient
 * refusal read as a permanent fault — across both layers.
 *
 * PHRASES ONLY, NEVER BARE STATUS NUMBERS. `\b50[234]\b` would have been the
 * obvious way to catch 502/503/504 and it is a trap: a unique-violation message
 * quotes the offending key, and our keys look like `greenhouse:acme:502...`. So
 * a genuine constraint violation would match, get retried down to the floor, and
 * arrive as a confusing slow failure instead of a clear immediate one.
 *
 * Narrow on purpose. A constraint violation, a missing column or a bad payload
 * is a real fault and must still fail loudly on the first attempt — asserted in
 * tests/transient-errors.test.ts. Anything that still fails at the floor throws
 * regardless, so a mistake here delays a failure rather than hiding it.
 */
const TRANSIENT = new RegExp(
  [
    // Postgres itself ran out of time, or could not get a lock.
    'statement timeout',
    'canceling statement',
    'deadlock detected',
    // Postgres going away under us: a restart, a failover, a dropped backend.
    'terminating connection',
    'server closed the connection',
    // The gateway in front of it gave up. This is the one that cost a shard.
    'gateway time-?out',
    'bad gateway',
    'service unavailable',
    'upstream connect error',
    'upstream request timeout',
    // The request never completed at the socket level.
    'ECONNRESET',
    'socket hang up',
    'fetch failed',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_',
  ].join('|'),
  'i',
);

/**
 * Reads every page of something, halving the page whenever the database says it
 * ran out of time.
 *
 * The read twin of `upsertInChunks`, and it exists because the write path had
 * this protection and the read path did not. The close-scan — which pages
 * through all 67,000 open postings to find the ones an employer has withdrawn —
 * threw on its first refusal:
 *
 *   crawl failed: supabase close-scan failed: canceling statement due to
 *   statement timeout
 *
 * That was one of the four crawl failures on record, and the shard's work was
 * already written by then: what it actually cost was that run's closing pass
 * plus a false alarm on a healthy crawl.
 *
 * TWO THINGS WORTH KNOWING ABOUT THE PAGING.
 *
 * It stops on an EMPTY page, not on a short one. A short page is ambiguous once
 * the size can shrink — it may be the end of the data or merely a smaller ask —
 * and guessing wrong silently truncates the scan, which would make the crawl
 * think postings had vanished. One extra round trip per scan is a cheap price
 * for that being unambiguous.
 *
 * It advances by the number of rows actually RECEIVED rather than by the size
 * requested, so a halved page cannot skip the rows it did not fetch.
 *
 * `read` is injected so this can be tested without a database.
 */
export async function readInPages<T>(
  read: (from: number, size: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
  opts: {
    page?: number;
    /** Below this, a timeout is the database's problem, not the page size. */
    floor?: number;
    onRetry?: (size: number, next: number, message: string) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T[]> {
  const start = opts.page ?? PAGE;
  const floor = opts.floor ?? 50;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const out: T[] = [];
  let from = 0;
  let size = start;
  for (;;) {
    const { data, error } = await read(from, size);
    if (error) {
      if (!isTransientWriteError(error.message) || size <= floor) {
        throw new Error(`supabase close-scan failed: ${error.message}`);
      }
      const next = Math.max(floor, Math.floor(size / 2));
      opts.onRetry?.(size, next, error.message);
      size = next;
      // The other three shards are writing into this table right now; a moment's
      // pause is as much of the remedy as the smaller page.
      await wait(250);
      continue;
    }
    const batch = data ?? [];
    // Empty, not short — see above.
    if (batch.length === 0) return out;
    out.push(...batch);
    from += batch.length;
  }
}

/**
 * Writes rows in chunks, halving the chunk whenever the database says it ran
 * out of time.
 *
 * THE BUG THIS EXISTS FOR
 *
 * A shard that had crawled 5,608 boards and collected 15,746 roles threw all of
 * it away because one 500-row statement timed out:
 *
 *   crawl failed: supabase upsert failed: canceling statement due to statement
 *   timeout
 *
 * Twice in thirty runs, 6 and 7 September. The crawl itself was fine both
 * times; only the write failed, and the run had no smaller thing to try.
 *
 * Halving is the right response because the failure is about statement SIZE
 * under contention, not about the data. Anything that still fails at the floor
 * throws, so a genuine fault is never swallowed — and nothing is skipped, ever:
 * a chunk is either written or the run fails.
 *
 * `write` is injected so this can be tested without a database.
 */
export async function upsertInChunks<T>(
  rows: T[],
  write: (chunk: T[]) => Promise<{ error: { message: string } | null; count: number | null }>,
  opts: {
    chunk?: number;
    /** Below this, a timeout is the database's problem, not the batch size. */
    floor?: number;
    onRetry?: (size: number, next: number, message: string) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const start = opts.chunk ?? 500;
  const floor = opts.floor ?? 25;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let written = 0;
  for (let i = 0; i < rows.length; ) {
    let size = Math.min(start, rows.length - i);
    for (;;) {
      const slice = rows.slice(i, i + size);
      const { error, count } = await write(slice);
      if (!error) {
        written += count ?? slice.length;
        i += size;
        break;
      }
      if (!isTransientWriteError(error.message) || size <= floor) {
        throw new Error(`supabase upsert failed: ${error.message}`);
      }
      const next = Math.max(floor, Math.floor(size / 2));
      opts.onRetry?.(size, next, error.message);
      // A short pause as well as a smaller statement: the other three shards are
      // writing to this same table, and retrying instantly just collides again.
      await wait(250);
      size = next;
    }
  }
  return written;
}

/**
 * Which boards this run is allowed to close postings on.
 *
 * A posting is closed when its board was read successfully and the posting was
 * not in what came back. The scope is `provider:token`, because that is what a
 * job row records — `toJobRow` takes board_token from the job key.
 *
 * ALL-OR-NOTHING PER TOKEN, and that is the whole point of this function.
 *
 * A Workday token is a TENANT, and a tenant can run several career sites. Once
 * the registry could hold more than one, two boards began sharing a token: both
 * of the Nevada System of Higher Education's campuses write board_token `nshe`.
 * If one campus were read and the other refused, the successful one would
 * authorise closing, the refused one's postings would be missing from what came
 * back, and all 133 of them would be closed as withdrawn.
 *
 * That is the same wipe the provider+token scoping already exists to prevent,
 * one level further down. So a token is closable only when EVERY board under it
 * came back with jobs. The cost is that a withdrawn posting waits for the next
 * clean run; the alternative is deleting live jobs, which is not a trade.
 *
 * For a token with one board — every provider but Workday, and most of Workday
 * too — this is exactly the old behaviour.
 */
export function closableBoards(boards: { provider: string; token?: string; jobs: number; error?: unknown }[]): Set<string> {
  const byToken = new Map<string, boolean>();
  for (const b of boards) {
    if (!b.token) continue;
    const key = `${b.provider}:${b.token}`;
    const healthy = !b.error && b.jobs > 0;
    byToken.set(key, (byToken.get(key) ?? true) && healthy);
  }
  return new Set([...byToken].filter(([, ok]) => ok).map(([key]) => key));
}

export async function writeFeed(feed: Feed): Promise<{ upserted: number; closed: number }> {
  const client = dbWrite();
  // crawl_runs.started_at defaulted to now() at INSERT time, which is stamped
  // milliseconds AFTER the client-supplied finished_at — so every row recorded a
  // negative duration and the table could not answer "how long did that take".
  const startedAt = new Date().toISOString();

  // Deduplicate by key before writing. Workday reuses one requisition id across
  // every location a role is posted in, so the same key can appear several times
  // in a crawl — and Postgres rejects an upsert that touches a row twice in the
  // same statement ("ON CONFLICT DO UPDATE cannot affect row a second time").
  const byKey = new Map<string, (typeof feed.jobs)[number]>();
  for (const j of feed.jobs) if (!byKey.has(j.key)) byKey.set(j.key, j);

  const rows = [...byKey.values()].map((j) => toJobRow(j));

  // Chunked, and halved again whenever the database says a statement ran out of
  // time. This used to be a plain 500-at-a-time loop that threw on the first
  // error, so a whole shard's crawl was discarded because one write ran long.
  const upserted = await upsertInChunks(rows, async (chunk) => {
    // count:'exact' so jobs_upserted records rows actually written rather than
    // rows attempted — the old counter reported the input size unconditionally,
    // which would read as a full success even if nothing changed.
    let { error, count } = await client
      .from('jobs')
      .upsert(chunk, { onConflict: 'key', count: 'exact' });

    // Migrations here are applied by hand, so code and schema are briefly out of
    // step by design — and the crawl runs hourly, which means a column this
    // writes but the database does not yet have would fail every run in between.
    // Dropping the unknown column and retrying keeps the corpus updating until
    // the migration lands; the value is lost for those runs and nothing else is.
    //
    // Narrow on purpose: only a missing-column error, only the columns named
    // here, and it says so loudly every time rather than healing in silence.
    const missing = error && /column "?(\w+)"? .*does not exist/i.exec(error.message)?.[1];
    if (missing && ['adjacent', 'sector', 'specialization', 'specialization_reason', 'classification_version'].includes(missing)) {
      console.error(
        `jobs.${missing} does not exist yet — writing without it. ` +
          'Apply the pending migration in src/db/migrations/ to stop losing this field.',
      );
      const stripped = chunk.map((row) => {
        const copy = { ...(row as Record<string, unknown>) };
        delete copy[missing];
        return copy;
      });
      ({ error, count } = await client
        .from('jobs')
        .upsert(stripped as typeof chunk, { onConflict: 'key', count: 'exact' }));
    }

    return { error, count };
  }, {
    onRetry: (size, next, message) =>
      console.warn(`  upsert of ${size} rows timed out, retrying ${next} at a time — ${message}`),
  });

  // Close postings that vanished, but only on boards that returned data this
  // run — otherwise one failing board would wipe its entire history.
  //
  // Scoped by provider+token rather than company name. Thirteen companies in the
  // board list run two boards each, so matching on the name alone let a healthy
  // Greenhouse board authorise closing every job from the same company's failing
  // Ashby board — the exact wipe this scoping exists to prevent.
  const healthyBoards = closableBoards(feed.boards);
  const seenKeys = new Set(feed.jobs.map((j) => j.key));
  let closed = 0;

  if (healthyBoards.size > 0 && seenKeys.size > 0) {
    // Paged. A bare select is capped at 1000 rows by PostgREST, so with 3,535
    // open jobs, 72% of them were structurally unclosable — they stayed on the
    // site forever after the employer withdrew them. Ordered by key so the
    // page boundaries are stable across requests.
    type OpenRow = { key: string; provider: string; board_token: string };
    const open: OpenRow[] = await readInPages<OpenRow>(
      (from, size) =>
        client
          .from('jobs')
          .select('key,provider,board_token')
          .is('closed_at', null)
          .order('key', { ascending: true })
          .range(from, from + size - 1) as unknown as Promise<{
          data: OpenRow[] | null;
          error: { message: string } | null;
        }>,
      {
        onRetry: (size, next, message) =>
          console.warn(`  close-scan page of ${size} failed, retrying ${next} — ${message}`),
      },
    );

    const stale = open
      .filter((r) => healthyBoards.has(`${r.provider}:${r.board_token}`))
      .filter((r) => !seenKeys.has(r.key))
      .map((r) => r.key);

    // FILTER_CHUNK, not CHUNK: these keys travel in the URL, not the body.
    for (let i = 0; i < stale.length; i += FILTER_CHUNK) {
      const chunk = stale.slice(i, i + FILTER_CHUNK);
      const { error } = await client
        .from('jobs')
        .update({ closed_at: new Date().toISOString() })
        .in('key', chunk);
      // Previously a failed close just failed to increment the counter, so a
      // broken close pass was indistinguishable from having nothing to close.
      if (error) {
        console.error(`close failed for ${chunk.length} jobs: ${error.message}`);
        continue;
      }
      closed += chunk.length;
    }
  }

  // Reclaim rows nothing will ever serve again.
  //
  // Nothing deleted from `jobs` before this: rows only ever had closed_at set,
  // and readFeed filters them out at query time, so expired postings stayed
  // resident forever. At ~1 KB a row the 500 MB ceiling is far off, but the
  // board list tripled in a day and there was no purge, no TTL and no pg_cron.
  // Deleting only what is both closed and well past the retention window keeps
  // this safe: a job still inside MAX_AGE_DAYS is never touched.
  const purgeBefore = new Date(Date.now() - PURGE_AFTER_DAYS * 86_400_000).toISOString();
  const { error: purgeError, count: purged } = await client
    .from('jobs')
    .delete({ count: 'exact' })
    .not('closed_at', 'is', null)
    .lt('closed_at', purgeBefore);
  if (purgeError) {
    // Never fatal: reclaiming space must not fail a crawl that already wrote.
    console.error('purge failed:', purgeError.message);
  } else if (purged) {
    console.log(`purged ${purged} jobs closed before ${purgeBefore.slice(0, 10)}`);
  }

  // A crawl that persisted nothing must never stamp the corpus fresh. readFeed's
  // staleness guard only looks at the newest run's finished_at, so a total
  // pipeline failure used to be served as the previous run's rows under a
  // brand-new "updated 1m ago" — the failure mode hardest to notice. Throwing
  // instead leaves the corpus honestly stale and turns the workflow red.
  if (rows.length === 0) {
    const failed = feed.boards.filter((b) => b.error).length;
    throw new Error(
      `crawl persisted zero jobs (${failed} of ${feed.boards.length} boards failed) — ` +
        'refusing to mark the corpus fresh',
    );
  }

  await client.from('crawl_runs').insert({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    boards_total: feed.boards.length,
    boards_ok: feed.boards.filter((b) => !b.error).length,
    boards_failed: feed.boards.filter((b) => b.error).length,
    jobs_scanned: feed.scanned ?? feed.jobs.length,
    jobs_upserted: upserted,
    jobs_closed: closed,
  });

  return { upserted, closed };
}
