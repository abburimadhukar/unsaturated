/**
 * Oracle, end to end through the real code paths.
 *
 * Not a test: it talks to a live vendor. Runs the adapter, the description
 * backfill and the classifier over one real board, so the parts that a unit
 * test has to stub are the parts this actually exercises.
 *
 *   npx tsx scripts/oracle-check.mts [tenant host site]
 */
import { getAdapter } from '../src/ats/adapters/index.js';
import { backfillDescriptions, needsBackfill } from '../src/ats/describe.js';
import { classifyRole } from '../src/taxonomy/families.js';
import { config } from '../src/config.js';
import type { BoardRef } from '../src/ats/types.js';

const [token = 'hccz', host = 'hccz.fa.em3.oraclecloud.com', site = 'CX'] = process.argv.slice(2);
const board: BoardRef = { provider: 'oracle', token, extra: { host, site } };
const ctx = { userAgent: config.userAgent, timeoutMs: 30_000 };

let failures = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${!ok && detail ? `  — ${detail}` : ''}`);
};

console.log(`\n${token} / ${site} on ${host}\n`);

const jobs = await getAdapter('oracle').fetchJobs(board, ctx);
console.log(`fetched ${jobs.length} postings`);
check(jobs.length > 200, 'more than one page came back', `${jobs.length} is at or under the 200 cap`);
check(new Set(jobs.map((j) => j.externalId)).size === jobs.length, 'every posting has a distinct id');
check(jobs.every((j) => j.title.trim().length > 0), 'every posting has a title');
check(jobs.every((j) => (j.applyUrl ?? '').startsWith('https://')), 'every posting has an apply url');
check(
  jobs.filter((j) => j.postedAt).length / jobs.length > 0.9,
  'nearly every posting carries the employer’s own date',
);

check(needsBackfill('oracle'), 'oracle is marked as needing a description backfill');
const sample = jobs.slice(0, 5);
const filled = await backfillDescriptions(board, sample, ctx, 5, 2);
console.log(`\nbackfilled ${filled} of ${sample.length}`);
check(filled > 0, 'the detail endpoint returned something');
const described = sample.filter((j) => (j.descriptionText ?? '').length > 200);
check(described.length > 0, 'at least one description is a real body of text');
if (described[0]) {
  console.log(`  "${described[0].title}"`);
  console.log(`  ${described[0].descriptionText!.replace(/\s+/g, ' ').slice(0, 220)}…`);
  check(!/[<>]/.test(described[0].descriptionText!.slice(0, 400)), 'the html was stripped');
}

const families = new Map<string, number>();
for (const j of jobs) {
  const f = classifyRole(j);
  const key = f.family ?? f.excludedReason ?? 'no family matched';
  families.set(key, (families.get(key) ?? 0) + 1);
}
console.log('\nclassified:', [...families].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(' · '));

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
