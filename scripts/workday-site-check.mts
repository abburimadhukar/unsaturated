/**
 * Workday's second address, through the real verifier.
 *
 * Not a test: it talks to Workday. The path this exercises is the one a unit
 * test cannot reach — a tenant harvested with a site and NO shard, where
 * verification has to find the shard before it can say anything at all. Getting
 * that wrong reports live employers as dead, so it is checked against the
 * vendor rather than against a stub.
 *
 *   npx tsx scripts/workday-site-check.mts
 */
import { config } from '../src/config.js';
import { PATTERNS, toBoard } from '../src/discovery/commoncrawl.js';
import { verifyBoards } from '../src/discovery/verify.js';
import type { OpenBoard } from '../src/discovery/opendata.js';

const pattern = PATTERNS.find((p) => p.provider === 'workday' && p.match.includes('myworkdaysite'))!;

// Real archived urls, and deliberately a mix: tenants whose shard is wd1 (what
// the hostname says) and tenants whose shard is not (wd3, wd12). The second
// group is the whole reason the hostname is thrown away.
const URLS = [
  'https://wd1.myworkdaysite.com/en-US/recruiting/clorox/Clorox/job/x',
  'https://wd1.myworkdaysite.com/en-US/recruiting/baird/Careers/job/x',
  'https://wd1.myworkdaysite.com/de-DE/recruiting/whitecase/External/job/x',
  'https://wd1.myworkdaysite.com/en-US/recruiting/bsigroup/BSI_Careers/job/x',
  'https://wd1.myworkdaysite.com/en-US/recruiting/daher/Daher/job/x',
  'https://wd1.myworkdaysite.com/en-US/recruiting/parklandhospital/Parkland_Careers/job/x',
  'https://wd1.myworkdaysite.com/en-US/recruiting/heihotels/External_Career_Site/job/x',
  'https://wd1.myworkdaysite.com/en-US/recruiting/carislifesciences/CLS/job/x',
];

const boards: OpenBoard[] = [];
for (const u of URLS) {
  const b = toBoard(pattern, u);
  if (!b) throw new Error(`the pattern no longer reads ${u}`);
  if (b.extra?.host) throw new Error(`a host was recorded for ${b.token} — it must be discovered, not assumed`);
  boards.push(b);
}
console.log(`\n${boards.length} tenants harvested with a site and no shard\n`);

const results = await verifyBoards(boards, { userAgent: config.userAgent, delayMs: 900 });

let failures = 0;
const shards = new Set<string>();
for (const r of results) {
  const host = r.extra?.host ?? '(none)';
  const ok = r.verdict === 'live' && Boolean(r.extra?.host);
  if (!ok) failures++;
  if (r.extra?.host) shards.add(r.extra.host.split('.')[1]!);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${(r.board.token + '/' + (r.board.extra?.site ?? '')).padEnd(40)} ` +
      `${String(r.jobs).padStart(5)} jobs  ${host}`,
  );
}

console.log(`\nshards actually used: ${[...shards].sort().join(', ')}`);
if (shards.size < 2) {
  failures++;
  console.log('  FAIL  every tenant resolved to one shard — the discovery is not doing anything');
}
console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
