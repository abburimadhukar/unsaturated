import { getAdapter } from '../ats/adapters/index.js';
import type { AtsProvider } from '../ats/types.js';
import { config } from '../config.js';
import { scoreJob, type ScoredJob } from '../scoring/saturation.js';

/**
 * In-memory corpus.
 *
 * Deliberately database-free so the app runs against live ATS data on a clean
 * checkout. The Postgres path in src/ingest exists for the persistent crawl —
 * this is the same adapters and the same scorer, just held in memory.
 */

export interface SeedBoard {
  provider: AtsProvider;
  token: string;
  company: string;
  /** Caps pagination on enterprise boards so a refresh stays interactive. */
  maxJobs?: number;
}

/** Every token here was verified live and public during design. */
export const SEED_BOARDS: SeedBoard[] = [
  { provider: 'lever', token: 'lyrahealth', company: 'Lyra Health' },
  { provider: 'ashby', token: 'ashby', company: 'Ashby' },
  { provider: 'greenhouse', token: 'gruve', company: 'Gruve' },
  { provider: 'workable', token: 'nationsecurity', company: 'Nation Security' },
  { provider: 'smartrecruiters', token: 'soprasteria1', company: 'Sopra Steria', maxJobs: 300 },
  { provider: 'breezy', token: 'breezy', company: 'Breezy HR' },
  { provider: 'personio', token: 'personio', company: 'Personio' },
];

export interface BoardHealth {
  provider: AtsProvider;
  token: string;
  company: string;
  jobs: number;
  ms: number;
  error?: string;
}

export interface CorpusSnapshot {
  jobs: ScoredJob[];
  boards: BoardHealth[];
  refreshedAt: Date;
}

let snapshot: CorpusSnapshot | null = null;
let inFlight: Promise<CorpusSnapshot> | null = null;

async function loadBoard(board: SeedBoard): Promise<{ scored: ScoredJob[]; health: BoardHealth }> {
  const started = Date.now();
  const health: BoardHealth = {
    provider: board.provider,
    token: board.token,
    company: board.company,
    jobs: 0,
    ms: 0,
  };

  try {
    const jobs = await getAdapter(board.provider).fetchJobs(
      { provider: board.provider, token: board.token },
      {
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
        ...(board.maxJobs !== undefined ? { maxJobs: board.maxJobs } : {}),
      },
    );

    const capped = board.maxJobs ? jobs.slice(0, board.maxJobs) : jobs;
    const scored = capped.map((job) =>
      scoreJob({
        job,
        provider: board.provider,
        boardToken: board.token,
        companyName: board.company,
        boardSize: jobs.length,
      }),
    );

    health.jobs = scored.length;
    health.ms = Date.now() - started;
    return { scored, health };
  } catch (err) {
    health.error = err instanceof Error ? err.message : String(err);
    health.ms = Date.now() - started;
    return { scored: [], health };
  }
}

export async function refreshCorpus(): Promise<CorpusSnapshot> {
  // Collapse concurrent refreshes; several browser tabs must not multiply load
  // on the upstream boards.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const results = await Promise.all(SEED_BOARDS.map(loadBoard));
    const jobs = results.flatMap((r) => r.scored).sort((a, b) => b.score - a.score);
    snapshot = { jobs, boards: results.map((r) => r.health), refreshedAt: new Date() };
    return snapshot;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export async function getCorpus(): Promise<CorpusSnapshot> {
  return snapshot ?? refreshCorpus();
}

export interface JobFilters {
  remote?: string;
  seniority?: string;
  provider?: string;
  minScore?: number;
  hideGhosts?: boolean;
  q?: string;
  limit?: number;
}

export function filterJobs(all: ScoredJob[], f: JobFilters): ScoredJob[] {
  let out = all;

  if (f.remote) out = out.filter((s) => s.job.remoteType === f.remote);
  if (f.seniority) out = out.filter((s) => s.job.seniority === f.seniority);
  if (f.provider) out = out.filter((s) => s.provider === f.provider);
  if (f.minScore !== undefined) out = out.filter((s) => s.score >= f.minScore!);
  if (f.hideGhosts) out = out.filter((s) => s.components.ghostRisk < 0.4);

  if (f.q) {
    const needle = f.q.toLowerCase();
    out = out.filter(
      (s) =>
        s.job.title.toLowerCase().includes(needle) ||
        s.companyName.toLowerCase().includes(needle) ||
        (s.job.locationRaw ?? '').toLowerCase().includes(needle),
    );
  }

  return out.slice(0, f.limit ?? 100);
}
