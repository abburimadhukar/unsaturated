import { db, dbWrite } from '../db/supabase.js';
import type { AtsProvider } from '../ats/types.js';
import type { Family } from '../taxonomy/families.js';
import { MAX_AGE_DAYS, type Feed, type FeedJob } from './live.js';

/**
 * Reads the corpus from Supabase and writes crawl results back to it.
 *
 * The read returns the same `Feed` shape the in-memory path produces, so every
 * filter, facet and sort already built and tested keeps working untouched — the
 * database is a storage swap, not a rewrite.
 */

interface JobRow {
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
  ai: boolean;
  matched_skills: string[] | null;
  skill_score: number | null;
  ghost_risk: number | null;
}

/** Supabase caps a single select at 1000 rows, so reads are paged. */
const PAGE = 1000;

function toFeedJob(r: JobRow, now: number): FeedJob {
  const postedMs = r.posted_at ? Date.parse(r.posted_at) : NaN;
  const ageDays = Number.isFinite(postedMs)
    ? Math.round((now - postedMs) / 86_400_000)
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
          'employment_type,department,salary_min,salary_max,salary_currency,posted_at,apply_url,family,ai,' +
          'matched_skills,skill_score,ghost_risk',
      )
      .is('closed_at', null)
      .not('family', 'is', null)
      // Undated postings are kept: several providers omit a publish date, and
      // excluding them would silently drop those boards entirely.
      .or(`posted_at.gte.${cutoff},posted_at.is.null`)
      .order('posted_at', { ascending: false, nullsFirst: false })
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
 * Writes a completed crawl to the database.
 *
 * Upserts every job seen, then closes anything on those boards that stopped
 * appearing. Closing is scoped to boards that actually returned results, so a
 * board erroring out never marks its whole catalogue as gone.
 */
export async function writeFeed(feed: Feed): Promise<{ upserted: number; closed: number }> {
  const client = dbWrite();

  // Deduplicate by key before writing. Workday reuses one requisition id across
  // every location a role is posted in, so the same key can appear several times
  // in a crawl — and Postgres rejects an upsert that touches a row twice in the
  // same statement ("ON CONFLICT DO UPDATE cannot affect row a second time").
  const byKey = new Map<string, (typeof feed.jobs)[number]>();
  for (const j of feed.jobs) if (!byKey.has(j.key)) byKey.set(j.key, j);

  const rows = [...byKey.values()].map((j) => ({
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
    ai: j.ai,
    matched_skills: j.matchedSkills,
    skill_score: j.skillScore,
    ghost_risk: j.components.ghostRisk ?? 0,
    last_seen_at: new Date().toISOString(),
    closed_at: null,
  }));

  let upserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await client.from('jobs').upsert(chunk, { onConflict: 'key' });
    if (error) throw new Error(`supabase upsert failed: ${error.message}`);
    upserted += chunk.length;
  }

  // Close postings that vanished, but only on boards that returned data this
  // run — otherwise one failing board would wipe its entire history.
  const healthyTokens = new Set(
    feed.boards.filter((b) => !b.error && b.jobs > 0).map((b) => b.company),
  );
  const seenKeys = new Set(feed.jobs.map((j) => j.key));
  let closed = 0;

  if (healthyTokens.size > 0 && seenKeys.size > 0) {
    const { data } = await client
      .from('jobs')
      .select('key,company')
      .is('closed_at', null);
    const stale = (data ?? [])
      .filter((r) => healthyTokens.has((r as { company: string }).company))
      .filter((r) => !seenKeys.has((r as { key: string }).key))
      .map((r) => (r as { key: string }).key);

    for (let i = 0; i < stale.length; i += CHUNK) {
      const chunk = stale.slice(i, i + CHUNK);
      const { error } = await client
        .from('jobs')
        .update({ closed_at: new Date().toISOString() })
        .in('key', chunk);
      if (!error) closed += chunk.length;
    }
  }

  await client.from('crawl_runs').insert({
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
