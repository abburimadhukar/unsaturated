import { getAdapter } from '../ats/adapters/index.js';
import { backfillDescriptions, needsBackfill } from '../ats/describe.js';
import { cleanLocation, inferCountry } from '../ats/geo.js';
import { inferSeniorityFromText } from '../ats/normalize.js';
import { parseSalary } from '../ats/salary.js';
import type { AtsProvider, BoardRef } from '../ats/types.js';
import { config } from '../config.js';
import { scoreJob } from '../scoring/saturation.js';
import { scoreFit } from '../scoring/fit.js';
import { classifyRole, type Family, type RoleClassification } from '../taxonomy/families.js';
import { loadBoards, type CorpusBoard } from './boards.js';
import { loadSnapshot } from './snapshot.js';

/**
 * Live corpus for the app.
 *
 * Runs in-process against the ATS adapters. The Postgres path in src/ingest is
 * the eventual home for this once thousands of boards are registered; until then
 * this keeps the app runnable on a clean checkout with no database.
 */

/** Postings older than this are dropped at ingest — three weeks. */
export const MAX_AGE_DAYS = 21;

export interface FeedJob {
  key: string;
  title: string;
  company: string;
  provider: AtsProvider;
  location: string | null;
  country: string | null;
  remoteType: string | null;
  seniority: string | null;
  employmentType: string | null;
  department: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  ageDays: number | null;
  applyUrl: string | null;

  saturation: number;
  components: Record<string, number>;
  reasons: string[];

  inScope: boolean;
  family: Family | null;
  /** AI/ML role, whatever its family. */
  ai: boolean;
  matchedSkills: string[];
  skillScore: number;
}

export interface BoardHealth {
  company: string;
  provider: AtsProvider;
  /**
   * The board's own token. Company names are not unique — 13 of them run two
   * boards each — so closing stale jobs has to key on provider+token or a
   * healthy board authorises closing a failing sibling's postings.
   */
  token?: string;
  jobs: number;
  kept: number;
  /** Descriptions fetched by the backfill pass. */
  described?: number;
  ms: number;
  error?: string;
}

export interface Feed {
  jobs: FeedJob[];
  boards: BoardHealth[];
  refreshedAt: string;
  /** 'snapshot' = baked at build time; 'live' = crawled in this process. */
  source?: 'snapshot' | 'live';
  /**
   * Total jobs seen by the crawl, including non-cloud ones. The snapshot keeps
   * only in-scope roles (418 of 9,822 — a 20x size cut), so this preserves the
   * honest "scanned" figure the header reports.
   */
  scanned?: number;
}

/**
 * Cache lives on globalThis for the same reason the user store does: Next gives
 * each route handler its own module instance, so module-scoped state would mean
 * /api/refresh and /api/feed each crawl all 289 boards independently and never
 * see each other's results.
 */
interface CacheShape {
  cached: Feed | null;
  /** When `cached` was populated, for expiry. */
  cachedAt: number;
  inFlight: Promise<Feed> | null;
}
/**
 * How long a served feed may be reused before re-reading the database.
 *
 * Five minutes, not one: a full read pulls ~2.8 MB from Supabase to serve 200
 * rows, and the crawler only writes hourly, so a 60-second TTL was re-reading
 * the same data 60 times an hour per warm instance — enough to burn the free
 * tier's 5 GB monthly egress in about 30 hours at trivial traffic. Nothing here
 * changes faster than the crawl that feeds it.
 */
const FEED_CACHE_MS = 5 * 60_000;

const CACHE_KEY = Symbol.for('unsaturated.corpus');

function cache(): CacheShape {
  const g = globalThis as unknown as Record<symbol, CacheShape | undefined>;
  let existing = g[CACHE_KEY];
  if (!existing) {
    existing = { cached: null, cachedAt: 0, inFlight: null };
    g[CACHE_KEY] = existing;
  }
  return existing;
}

/** Hours worked in a full-time year, for reading an hourly rate as annual pay. */
const HOURS_PER_YEAR = 2080;

/**
 * Sanity-checks a salary a provider gave us in a structured field.
 *
 * These are stored in an annual column, but not every provider means annual by
 * them — one published an hourly interval, which surfaced as a role paying
 * "$120 to $134" a year. Anything below a plausible annual wage is read as
 * hourly; anything below even a plausible hourly rate is discarded rather than
 * displayed, because a wrong number is worse than none.
 */
function annualiseStructured(value: number | undefined): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  if (value >= 15_000) return Math.round(value);
  if (value >= 8) return Math.round(value * HOURS_PER_YEAR);
  return undefined;
}

async function loadBoard(board: CorpusBoard, now: number) {
  const started = Date.now();
  const health: BoardHealth = {
    company: board.company,
    provider: board.provider,
    token: board.token,
    jobs: 0,
    kept: 0,
    ms: 0,
  };
  const out: FeedJob[] = [];

  try {
    const jobs = await getAdapter(board.provider).fetchJobs(
      {
        provider: board.provider,
        token: board.token,
        ...(board.extra ? { extra: board.extra } : {}),
      },
      {
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
        ...(board.maxJobs !== undefined ? { maxJobs: board.maxJobs } : {}),
      },
    );
    health.jobs = jobs.length;

    // Retention cutoff first. Unknown dates are kept: dropping them would
    // silently remove whole providers whose feeds omit a publish date.
    const fresh = jobs.filter((job) => {
      if (!job.postedAt) return true;
      return Math.floor((now - job.postedAt.getTime()) / 86_400_000) <= MAX_AGE_DAYS;
    });

    // Descriptions cost one request per job, so only jobs that already look like
    // cloud roles are backfilled. Backfilling the whole crawl would be tens of
    // thousands of requests to make a handful of fit scores work.
    if (needsBackfill(board.provider)) {
      const candidates = fresh.filter((job) => classifyRole(job).family !== null);
      const ref: BoardRef = {
        provider: board.provider,
        token: board.token,
        ...(board.extra ? { extra: board.extra } : {}),
      };
      health.described = await backfillDescriptions(ref, candidates, {
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
      });
    }

    for (const job of fresh) {
      const ageMs = job.postedAt ? now - job.postedAt.getTime() : null;
      // Floor, not round — see db-feed.ts.
      const ageDays = ageMs === null ? null : Math.floor(ageMs / 86_400_000);

      // Re-classified after backfill so a newly fetched description contributes
      // its skills to both the fingerprint and the fit match.
      const cls: RoleClassification = classifyRole(job);

      // Only Lever publishes a structured salary, so for everyone else the pay
      // has to be read out of the description. Never overwrite a figure the
      // employer stated in a real field.
      const parsedPay =
        job.salaryMin === undefined && job.salaryMax === undefined
          ? parseSalary(job.descriptionText)
          : undefined;
      const scored = scoreJob({
        job,
        provider: board.provider,
        boardToken: board.token,
        companyName: board.company,
        boardSize: jobs.length,
        now,
      });

      out.push({
        key: `${board.provider}:${board.token}:${job.externalId}`,
        title: job.title,
        company: board.company,
        provider: board.provider,
        location: cleanLocation(job.locationRaw),
        country: inferCountry(job.locationRaw, job.country) ?? null,
        remoteType: job.remoteType ?? null,
        // Descriptions are only present after the backfill pass, so this is the
        // first point where a level can be read out of the text.
        seniority: job.seniority ?? inferSeniorityFromText(job.descriptionText) ?? null,
        employmentType: job.employmentType ?? null,
        department: job.department ?? null,
        // annualiseStructured, because a structured field is not always annual:
        // one provider published an hourly interval and it was written straight
        // into the annual column, so a role showed as "$120–$134" a year.
        salaryMin: annualiseStructured(job.salaryMin) ?? parsedPay?.min ?? null,
        salaryMax: annualiseStructured(job.salaryMax) ?? parsedPay?.max ?? null,
        salaryCurrency: job.salaryCurrency ?? parsedPay?.currency ?? null,
        postedAt: job.postedAt?.toISOString() ?? null,
        ageDays,
        applyUrl: job.applyUrl ?? null,
        saturation: scored.score,
        components: scored.components as unknown as Record<string, number>,
        reasons: scored.reasons,
        inScope: cls.family !== null,
        ai: cls.ai,
        family: cls.family,
        // Every skill the posting named, not only the winning family's. Storing
        // just the family fingerprint meant a job filed as `software` discarded
        // the AWS and Terraform it also listed, so a cloud candidate scored 0%
        // against it.
        matchedSkills: cls.allSkills.length > 0 ? cls.allSkills : cls.matchedSkills,
        skillScore: cls.score,
      });
    }

    health.kept = out.length;
  } catch (err) {
    health.error = err instanceof Error ? err.message : String(err);
  }

  health.ms = Date.now() - started;
  return { jobs: out, health };
}

export async function refreshFeed(): Promise<Feed> {
  const c = cache();
  // Collapse concurrent refreshes so multiple tabs don't multiply upstream load.
  if (c.inFlight) return c.inFlight;

  c.inFlight = (async () => {
    const now = Date.now();
    const boards = loadBoards();

    // Bounded pool — firing 200+ simultaneous requests at these vendors would be
    // abusive and would get the crawler rate-limited within a single refresh.
    const results: { jobs: FeedJob[]; health: BoardHealth }[] = [];
    let cursor = 0;
    // config.concurrency, not a hardcoded 8: setting CRAWLER_CONCURRENCY in the
    // workflow had no effect at all on the path that workflow actually runs.
    const workers = Array.from({ length: Math.min(config.concurrency, boards.length) }, async () => {
      while (cursor < boards.length) {
        const board = boards[cursor++];
        if (!board) break;
        results.push(await loadBoard(board, now));
      }
    });
    await Promise.all(workers);

    c.cached = {
      jobs: results.flatMap((r) => r.jobs).sort((a, b) => b.saturation - a.saturation),
      boards: results.map((r) => r.health),
      refreshedAt: new Date().toISOString(),
      source: 'live',
    };
    // Stamp the cache we just filled. Without this getFeed's TTL check reads a
    // cachedAt of 0, treats the fresh crawl as already expired, and re-crawls
    // every board on the very next request.
    c.cachedAt = Date.now();
    return c.cached;
  })();

  try {
    return await c.inFlight;
  } finally {
    c.inFlight = null;
  }
}

export async function getFeed(): Promise<Feed> {
  const c = cache();
  // Expire the cache. Without a TTL a warm serverless instance serves whatever
  // it first read for as long as it stays alive — the crawler would update the
  // database hourly and the site would keep showing hours-old data.
  if (c.cached && Date.now() - c.cachedAt < FEED_CACHE_MS) return c.cached;

  // Source order: database, then the build snapshot, then a live crawl.
  //
  // The database is authoritative once the crawler is filling it, and reading it
  // means the site is current without a redeploy. readFeed() returns null when
  // the corpus is stale or unreachable, which hands over to the snapshot rather
  // than serving jobs nobody is refreshing.
  try {
    const { readFeed } = await import('./db-feed.js');
    const fromDb = await readFeed();
    if (fromDb && fromDb.jobs.length > 0) {
      c.cached = fromDb;
      c.cachedAt = Date.now();
      return fromDb;
    }
  } catch (err) {
    console.error('db feed unavailable, falling back to snapshot:', err);
  }

  const snap = await loadSnapshot();
  if (snap) {
    c.cached = { ...snap, source: 'snapshot' };
    c.cachedAt = Date.now();
    return c.cached;
  }

  // Local development with neither database nor snapshot: crawl live.
  return refreshFeed();
}

export type SortKey = 'newest' | 'salary' | 'fit';

export interface FeedQuery {
  cloudOnly?: boolean;
  remote?: string;
  seniority?: string;
  family?: string;
  provider?: string;
  country?: string;
  minSaturation?: number;
  minFit?: number;
  postedWithinDays?: number;
  employmentType?: string;
  hasSalary?: boolean;
  minSalary?: number;
  ai?: boolean;
  /** Keep rows whose filtered field is unknown rather than dropping them. */
  includeUnknown?: boolean;
  hideGhosts?: boolean;
  hideSeen?: boolean;
  seenKeys?: Set<string>;
  q?: string;
  skills?: string[];
  sort?: SortKey;
}

export interface Facets {
  family: Record<string, number>;
  provider: Record<string, number>;
  remote: Record<string, number>;
  country: Record<string, number>;
}

/** Counts across a result set so the UI can show how much each filter would keep. */
export function facetsFor(rows: FeedRow[]): Facets {
  const family: Record<string, number> = {};
  const provider: Record<string, number> = {};
  const remote: Record<string, number> = {};
  const country: Record<string, number> = {};
  for (const r of rows) {
    if (r.family) family[r.family] = (family[r.family] ?? 0) + 1;
    provider[r.provider] = (provider[r.provider] ?? 0) + 1;
    const key = r.remoteType ?? 'unknown';
    remote[key] = (remote[key] ?? 0) + 1;
    const c = r.country ?? 'unknown';
    country[c] = (country[c] ?? 0) + 1;
  }
  return { family, provider, remote, country };
}

export interface FeedRow extends FeedJob {
  fit: number;
  fitKnown: boolean;
  fitBasis: number;
  fitConfidence: number;
  fitHave: string[];
  fitMissing: string[];
}

/**
 * Rough USD conversion for ranking only — never for display.
 *
 * Salary sorting compared raw integers across currencies, so a 408,000 PLN
 * salary (about $102k) outranked $405,500 USD. Exact rates do not matter for
 * ordering; being within ~10% does. Unpriced jobs return undefined so the
 * caller decides where they belong rather than being coerced to 0.
 */
const USD_PER: Record<string, number> = {
  USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.65, NZD: 0.6,
  CHF: 1.12, SEK: 0.095, NOK: 0.092, DKK: 0.145, PLN: 0.25, CZK: 0.043,
  HUF: 0.0027, RON: 0.22, INR: 0.012, SGD: 0.74, HKD: 0.128, JPY: 0.0064,
  BRL: 0.18, MXN: 0.05, ZAR: 0.055, ILS: 0.27, AED: 0.27, PHP: 0.017,
};

function usdValue(j: { salaryMin: number | null; salaryMax: number | null; salaryCurrency: string | null }): number | undefined {
  const raw = j.salaryMax ?? j.salaryMin;
  if (raw === null) return undefined;
  const rate = USD_PER[(j.salaryCurrency ?? 'USD').toUpperCase()] ?? 1;
  return raw * rate;
}

/** Collapses vendor employment-type spellings onto one canonical word. */
export function canonicalEmployment(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  if (/\b(intern|internship|trainee|apprentice)\b/.test(t)) return 'internship';
  if (/\b(part[\s_-]?time|parttime)\b/.test(t)) return 'part_time';
  if (/\b(contract|contractor|freelance|temporary|temp|fixed[\s_-]?term|b2b)\b/.test(t)) return 'contract';
  if (/\b(volunteer)\b/.test(t)) return 'volunteer';
  if (/\b(full[\s_-]?time|fulltime|permanent|regular|indefinite)\b/.test(t)) return 'full_time';
  return undefined;
}

/** Collapses vendor seniority spellings onto the canonical ladder. */
export function canonicalLevel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.toLowerCase();
  if (/^not applicable$|^n\/?a$/.test(t.trim())) return undefined;
  if (/\b(intern|student|trainee)\b/.test(t)) return 'entry';
  if (/\b(entry|junior|graduate|new grad|associate)\b/.test(t)) return 'entry';
  if (/\b(executive|chief|vp|vice president)\b/.test(t)) return 'executive';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\b(principal|distinguished|fellow)\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\bmid[\s-]senior\b/.test(t)) return 'senior';
  if (/\bsenior\b/.test(t)) return 'senior';
  // "(Non-Manager)" contains "manager" — Workday's exact phrasing — so this has
  // to be ruled out before the manager test, or an individual contributor is
  // filed as a tech lead.
  if (/\bnon[\s-]?manager\b/.test(t)) return 'mid';
  if (/\b(manager|head of|lead)\b/.test(t)) return 'lead';
  if (/\b(mid|intermediate|experienced)\b/.test(t)) return 'mid';
  return undefined;
}

export function queryFeed(feed: Feed, f: FeedQuery): FeedRow[] {
  const skills = f.skills ?? [];

  let rows: FeedRow[] = feed.jobs.map((j) => {
    const fit = scoreFit(skills, { matchedSkills: j.matchedSkills });
    return {
      ...j,
      fit: fit.score,
      fitKnown: fit.known,
      fitBasis: fit.basis,
      fitConfidence: fit.confidence,
      fitHave: fit.have,
      fitMissing: fit.missing,
    };
  });

  if (f.cloudOnly !== false) rows = rows.filter((j) => j.inScope);
  // Unknown values are KEPT by default. A job we could not classify is not the
  // same as a job that fails the filter, and dropping it silently means the user
  // never learns it existed — 150 roles disappeared behind the default country
  // filter alone, many of them almost certainly US.
  const keepUnknown = f.includeUnknown !== false;
  const pass = (value: string | null | undefined, want: string) =>
    value == null || value === '' ? keepUnknown : value === want;

  if (f.remote) rows = rows.filter((j) => pass(j.remoteType, f.remote!));
  if (f.seniority) {
    // Compared with `===` against raw vendor strings, so "entry" and
    // "entry level" were disjoint sets and the dropdown reached neither
    // cleanly. Both sides are canonicalised now.
    const wantLevel = canonicalLevel(f.seniority);
    rows = rows.filter((j) => {
      const got = canonicalLevel(j.seniority);
      if (!got) return keepUnknown;
      return got === wantLevel;
    });
  }
  if (f.employmentType) {
    // Canonical buckets, because vendors spell this every possible way:
    // "Full-time", "FullTime", "full_time", "Permanent", "Regular".
    //
    // This was a substring `.includes()` test, which made the filter a no-op for
    // every value: `employmentType=zzzz` returned 2,201 jobs, and "intern"
    // matched "International Office Entity" — the only "internship" it found.
    const want = canonicalEmployment(f.employmentType);
    rows = rows.filter((j) => {
      const got = canonicalEmployment(j.employmentType);
      if (!got) return keepUnknown;
      return got === want;
    });
  }
  if (f.family) rows = rows.filter((j) => j.family === f.family);
  if (f.provider) rows = rows.filter((j) => j.provider === f.provider);
  if (f.country) rows = rows.filter((j) => pass(j.country, f.country!));
  if (f.postedWithinDays !== undefined) {
    // Undated jobs are kept for the same reason ingest keeps them: several
    // providers omit a publish date, and dropping them silently removes those
    // boards. This was the only filter in the function that deleted them.
    rows = rows.filter(
      (j) => (j.ageDays === null ? keepUnknown : j.ageDays <= f.postedWithinDays!),
    );
  }
  if (f.hasSalary) rows = rows.filter((j) => j.salaryMin !== null || j.salaryMax !== null);
  if (f.minSalary !== undefined) {
    rows = rows.filter((j) => (usdValue(j) ?? 0) >= f.minSalary!);
  }
  if (f.hideSeen && f.seenKeys) rows = rows.filter((j) => !f.seenKeys!.has(j.key));
  // Jobs with no description are never excluded by a fit threshold — we can't
  // judge them, and silently dropping them would remove whole providers.
  if (f.minFit !== undefined && skills.length > 0) {
    rows = rows.filter((j) => !j.fitKnown || j.fit >= f.minFit!);
  }
  if (f.ai) rows = rows.filter((j) => j.ai);
  if (f.hideGhosts) rows = rows.filter((j) => (j.components.ghostRisk ?? 0) < 0.4);

  if (f.q) {
    const needle = f.q.toLowerCase();
    rows = rows.filter(
      (j) =>
        j.title.toLowerCase().includes(needle) ||
        j.company.toLowerCase().includes(needle) ||
        (j.location ?? '').toLowerCase().includes(needle),
    );
  }

  switch (f.sort) {
    case 'newest':
      rows.sort((a, b) => (a.ageDays ?? 9999) - (b.ageDays ?? 9999));
      break;
    case 'salary':
      // Compared in USD. Ranking the raw integers put 408,000 PLN (~$102k)
      // above $405,500 USD, and the same comparator backs the minSalary filter.
      rows.sort((a, b) => (usdValue(b) ?? -1) - (usdValue(a) ?? -1));
      break;
    case 'fit':
      // Ranked on evidence-discounted confidence, so a 100% match against one
      // named skill does not outrank a 100% match against ten. Unmeasurable fit
      // sorts last rather than being treated as a middling score.
      rows.sort((a, b) => (b.fitKnown ? b.fitConfidence : -1) - (a.fitKnown ? a.fitConfidence : -1));
      break;
    default:
      rows.sort((a, b) => b.saturation - a.saturation);
  }

  return rows;
}
