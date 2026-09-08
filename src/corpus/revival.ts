/**
 * What may come back from retirement, and what must never be reconsidered.
 *
 * A module of its own rather than functions on the CLI, because importing a CLI
 * runs it: `boards-revive.ts` ends in `main().catch(...)`, so a test that pulled
 * these rules out of that file would start a live pass over the registry — and
 * without `--dry-run` in its argv, that pass WRITES. The rules are the part
 * worth testing, so they live where testing them is free.
 */
import type { VerifyResult } from '../discovery/verify.js';

/**
 * A retirement somebody chose, rather than one a failure caused.
 *
 * `boards-dedupe` switches off the second registration of a board that was
 * stored twice under two spellings — the seed file holds both `cleric` and
 * `Cleric`, and these APIs treat them as one board. 330 boards are retired this
 * way and all 330 were verified on 8 Sep 2026 to point at a board that is still
 * active. Reviving one means crawling that company twice and storing every
 * posting under two job keys, which is the bug dedupe exists to prevent.
 *
 * Anchored at the start of the string on purpose. A message that merely mentions
 * the phrase is an ordinary failure and stays eligible.
 */
export function isDeliberateRetirement(lastError: string | null): boolean {
  return /^\s*duplicate spelling of /i.test(lastError ?? '');
}

/**
 * What earns a board its place back: it answered, and what it said was readable.
 *
 * Deliberately not "it answered". `teamtailor:app`, `discover` and
 * `integrations` are Teamtailor's OWN marketing subdomains, swept in from the
 * URL index; they return 200 and a landing page to `/jobs.json`, which counts as
 * zero jobs and is indistinguishable from a real board with nothing open unless
 * the parse is checked. A rule of "it answered" resurrects all three to fail
 * forever.
 *
 * And deliberately not "it has jobs". `workday:childrensplace` and
 * `workday:rangersmlb` both answered with total=0 on 8 Sep. They are real
 * employers between vacancies, and dropping a company for having an empty week
 * is how a registry quietly shrinks.
 *
 * `parsed` is optional on VerifyResult, so the absent answer must be the
 * cautious one: an older result, or a path that forgot to set it, does not get
 * to bring a board back.
 */
export function shouldRevive(r: Pick<VerifyResult, 'verdict' | 'parsed'>): boolean {
  return r.verdict === 'live' && r.parsed === true;
}
