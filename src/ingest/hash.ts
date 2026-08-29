import { createHash } from 'node:crypto';
import { normalizeLocation, normalizeTitle } from '../ats/normalize.js';
import type { NormalizedJob } from '../ats/types.js';

function sha256(parts: (string | number | undefined)[]): string {
  const h = createHash('sha256');
  for (const part of parts) h.update(String(part ?? ''), 'utf8');
  return h.digest('hex');
}

/** Changes when the posting's substance changes — drives "was this edited?". */
export function contentHash(job: NormalizedJob): string {
  return sha256([
    job.title,
    job.descriptionText,
    job.locationRaw,
    job.salaryMin,
    job.salaryMax,
    job.employmentType,
  ]);
}

/**
 * Stable across relistings. Reposts almost always arrive with a fresh
 * external_id, so identity has to be derived from what a human would recognise
 * as "the same job at the same company" — normalized title plus location on the
 * same board. This is what turns a repost into a detectable event, and reposts
 * are the strongest available signal for a ghost job.
 */
export function identityHash(boardId: string, job: NormalizedJob): string {
  return sha256([boardId, normalizeTitle(job.title), normalizeLocation(job.locationRaw)]);
}
