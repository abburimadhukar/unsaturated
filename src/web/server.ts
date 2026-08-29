import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { filterJobs, getCorpus, refreshCorpus } from './corpus.js';
import type { ScoredJob } from '../scoring/saturation.js';

/**
 * Web layer for the review queue.
 *
 * No framework and no database: the point is that a clean checkout can serve
 * live, scored ATS data immediately. Everything here is read-only against the
 * outside world — nothing in this server submits an application.
 */

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

export type QueueState = 'pending_review' | 'approved' | 'declined';

interface QueueEntry {
  id: string;
  state: QueueState;
  addedAt: string;
  job: ScoredJob;
  /** Fields the engine will not answer on the user's behalf. */
  openQuestions: string[];
}

const queue = new Map<string, QueueEntry>();

const jobKey = (s: ScoredJob) => `${s.provider}:${s.boardToken}:${s.job.externalId}`;

/**
 * Questions that must never be auto-answered. A wrong answer here is a
 * misrepresentation on a real application, so they are surfaced to the user
 * rather than guessed — this is why the queue exists at all.
 */
function openQuestionsFor(s: ScoredJob): string[] {
  const q = ['Confirm work authorization for this location', 'Confirm sponsorship requirement'];
  const text = s.job.descriptionText ?? '';
  if (/\bcover letter\b/i.test(text)) q.push('Cover letter required — review before sending');
  if (/\b(clearance|ts\/sci|top secret)\b/i.test(text)) q.push('Security clearance status required');
  if (/\b(licen[cs]e|certification|board certified)\b/i.test(text)) q.push('Confirm licence/certification');
  return q;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Trims the scored job down to what the UI actually renders. */
function present(s: ScoredJob) {
  return {
    key: jobKey(s),
    title: s.job.title,
    company: s.companyName,
    provider: s.provider,
    location: s.job.locationRaw ?? null,
    remoteType: s.job.remoteType ?? null,
    seniority: s.job.seniority ?? null,
    salaryMin: s.job.salaryMin ?? null,
    salaryMax: s.job.salaryMax ?? null,
    salaryCurrency: s.job.salaryCurrency ?? null,
    postedAt: s.job.postedAt?.toISOString() ?? null,
    ageDays: s.job.postedAt
      ? Math.round((Date.now() - s.job.postedAt.getTime()) / 86_400_000)
      : null,
    applyUrl: s.job.applyUrl ?? null,
    score: s.score,
    components: s.components,
    reasons: s.reasons,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(fileURLToPath(new URL('./public/index.html', import.meta.url)));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/jobs' && method === 'GET') {
      const corpus = await getCorpus();
      const p = url.searchParams;
      const minScore = p.get('minScore');
      const jobs = filterJobs(corpus.jobs, {
        ...(p.get('remote') ? { remote: p.get('remote')! } : {}),
        ...(p.get('seniority') ? { seniority: p.get('seniority')! } : {}),
        ...(p.get('provider') ? { provider: p.get('provider')! } : {}),
        ...(minScore ? { minScore: Number.parseInt(minScore, 10) } : {}),
        ...(p.get('q') ? { q: p.get('q')! } : {}),
        hideGhosts: p.get('hideGhosts') === '1',
        limit: 150,
      });

      json(res, 200, {
        total: corpus.jobs.length,
        shown: jobs.length,
        refreshedAt: corpus.refreshedAt.toISOString(),
        boards: corpus.boards,
        jobs: jobs.map(present),
      });
      return;
    }

    if (url.pathname === '/api/refresh' && method === 'POST') {
      const corpus = await refreshCorpus();
      json(res, 200, { ok: true, total: corpus.jobs.length, refreshedAt: corpus.refreshedAt });
      return;
    }

    if (url.pathname === '/api/queue' && method === 'GET') {
      json(res, 200, {
        entries: [...queue.values()].map((e) => ({
          id: e.id,
          state: e.state,
          addedAt: e.addedAt,
          openQuestions: e.openQuestions,
          job: present(e.job),
        })),
      });
      return;
    }

    if (url.pathname === '/api/queue' && method === 'POST') {
      const body = await readBody(req);
      const key = String(body.key ?? '');
      const corpus = await getCorpus();
      const found = corpus.jobs.find((s) => jobKey(s) === key);
      if (!found) {
        json(res, 404, { error: 'job not found' });
        return;
      }
      if (!queue.has(key)) {
        queue.set(key, {
          id: key,
          state: 'pending_review',
          addedAt: new Date().toISOString(),
          job: found,
          openQuestions: openQuestionsFor(found),
        });
      }
      json(res, 200, { ok: true, size: queue.size });
      return;
    }

    if (url.pathname.startsWith('/api/queue/') && method === 'POST') {
      const [, , , id, action] = url.pathname.split('/');
      const entry = id ? queue.get(decodeURIComponent(id)) : undefined;
      if (!entry) {
        json(res, 404, { error: 'not in queue' });
        return;
      }
      if (action === 'approve') entry.state = 'approved';
      else if (action === 'decline') entry.state = 'declined';
      else if (action === 'remove') queue.delete(entry.id);
      else {
        json(res, 400, { error: 'unknown action' });
        return;
      }
      // Approval marks intent only. Phase 4 (the apply engine) is not built, so
      // nothing is transmitted to any employer from this server.
      json(res, 200, { ok: true, state: entry.state, submitted: false });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`unsaturated → http://localhost:${PORT}`);
  console.log('Loading live ATS boards on first request…');
});
