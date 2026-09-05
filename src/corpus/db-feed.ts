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
          'adjacent,specialization,specialization_reason,classification_version,ai,' +
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

  let upserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
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
    if (missing && ['adjacent', 'specialization', 'specialization_reason', 'classification_version'].includes(missing)) {
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

    if (error) throw new Error(`supabase upsert failed: ${error.message}`);
    upserted += count ?? chunk.length;
  }

  // Close postings that vanished, but only on boards that returned data this
  // run — otherwise one failing board would wipe its entire history.
  //
  // Scoped by provider+token rather than company name. Thirteen companies in the
  // board list run two boards each, so matching on the name alone let a healthy
  // Greenhouse board authorise closing every job from the same company's failing
  // Ashby board — the exact wipe this scoping exists to prevent.
  const healthyBoards = new Set(
    feed.boards
      .filter((b) => !b.error && b.jobs > 0 && b.token)
      .map((b) => `${b.provider}:${b.token}`),
  );
  const seenKeys = new Set(feed.jobs.map((j) => j.key));
  let closed = 0;

  if (healthyBoards.size > 0 && seenKeys.size > 0) {
    // Paged. A bare select is capped at 1000 rows by PostgREST, so with 3,535
    // open jobs, 72% of them were structurally unclosable — they stayed on the
    // site forever after the employer withdrew them. Ordered by key so the
    // page boundaries are stable across requests.
    const open: { key: string; provider: string; board_token: string }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from('jobs')
        .select('key,provider,board_token')
        .is('closed_at', null)
        .order('key', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`supabase close-scan failed: ${error.message}`);
      const batch = (data ?? []) as unknown as typeof open;
      open.push(...batch);
      if (batch.length < PAGE) break;
    }

    const stale = open
      .filter((r) => healthyBoards.has(`${r.provider}:${r.board_token}`))
      .filter((r) => !seenKeys.has(r.key))
      .map((r) => r.key);

    for (let i = 0; i < stale.length; i += CHUNK) {
      const chunk = stale.slice(i, i + CHUNK);
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
