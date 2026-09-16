/** What verification now calls these tenants, against the live vendor. */
import { config } from '../src/config.js';
import { verifyBoards } from '../src/discovery/verify.js';
import type { OpenBoard } from '../src/discovery/opendata.js';

const CASES: [string, string, string, string][] = [
  ['eofh', 'eofh.fa.em2.oraclecloud.com', 'CX', 'Tata Capital'],
  ['ibnjjb', 'ibnjjb.fa.ocs.oraclecloud.com', 'CX', 'Lifepoint Health'],
  ['emit', 'emit.fa.ca3.oraclecloud.com', 'CX', 'WSP'],
  ['hcbt', 'hcbt.fa.em2.oraclecloud.com', 'CX', 'Kotak Mahindra Bank Ltd'],
  ['hccz', 'hccz.fa.em3.oraclecloud.com', 'CX', 'Pearson'],
  ['fa-evax-saasfaprod1', 'fa-evax-saasfaprod1.fa.ocs.oraclecloud.com', 'CX_1', 'IHG'],
];

const boards: OpenBoard[] = CASES.map(([token, host, site]) => ({
  provider: 'oracle', token, company: token[0]!.toUpperCase() + token.slice(1), extra: { host, site },
}));

const results = await verifyBoards(boards, { userAgent: config.userAgent, delayMs: 900 });
let bad = 0;
for (let i = 0; i < results.length; i++) {
  const r = results[i]!, want = CASES[i]![3];
  const got = r.company ?? `(none — would stay "${r.board.company}")`;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.board.token.padEnd(22)} ${String(r.jobs).padStart(5)} jobs  ${got}`);
}
console.log(bad === 0 ? '\nALL NAMES RESOLVED\n' : `\n${bad} NAME(S) WRONG\n`);
process.exit(bad === 0 ? 0 : 1);
