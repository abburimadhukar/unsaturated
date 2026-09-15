/**
 * One real whole-resume rewrite, printed in full.
 *
 * Not a test: it spends money and needs a key. `npm test` globs tests/*.test.ts
 * only, so it cannot be reached from there.
 *
 *   npx tsx scripts/rewrite-eval.mts <resume.txt> <job-key> <title> <company>
 */
import { readFileSync } from 'node:fs';

import { describeJob } from '../src/tailor/jd.js';
import { assembleRewrite } from '../src/tailor/rewrite.js';
import { rewriteResume } from '../src/tailor/rewrite-run.js';
import { readShape } from '../src/tailor/sections.js';
import { describeTally, orderForReading } from '../src/tailor/coverage.js';
import { voiceProblems } from '../src/tailor/voice.js';

const [resumePath, jobKey, title, company] = process.argv.slice(2);
if (!resumePath || !jobKey) {
  console.error('usage: tsx scripts/rewrite-eval.mts <resume.txt> <job-key> <title> <company>');
  process.exit(1);
}

function apiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at > 0 && line.slice(0, at).trim() === 'OPENAI_API_KEY') {
        return line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no dev file */
  }
  return '';
}

const key = apiKey();
if (!key) {
  console.error('No OPENAI_API_KEY.');
  process.exit(1);
}

const rule = (s: string) => `\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`;
const resumeText = readFileSync(resumePath, 'utf8');

const jd = await describeJob({ key: jobKey, title: title ?? 'the role' });
if (!jd.ok) {
  console.error('no description:', jd.reason);
  process.exit(1);
}
console.log(rule('INPUT'));
console.log(`resume  : ${resumeText.length} chars`);
console.log(`posting : ${jd.text.length} chars via ${jd.via}`);

console.log(rule('REWRITING — this spends money'));
const started = Date.now();
const result = await rewriteResume(
  {
    resumeText,
    jobTitle: title ?? 'the role',
    company: company ?? '',
    jobDescription: jd.text,
  },
  { apiKey: key },
);
console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`note: ${result.note}`);
if (result.needsAttention) console.log('NEEDS ATTENTION');
if (!result.checked) process.exit(1);
const c = result.checked;

const mark = (v: string) => (v === 'kept' ? 'OK  ' : 'FLAG');

console.log(rule('WHAT THEY ASK FOR'));
console.log(describeTally(c.tally));
for (const r of orderForReading(c.requirements)) {
  const tag = { shown: 'SHOWN   ', partial: 'PARTLY  ', adjacent: 'ADJACENT', missing: 'MISSING ', unclear: 'UNCLEAR ' }[r.answer];
  console.log(`
[${tag}] ${r.need.toUpperCase().padEnd(11)} ${r.name}`);
  if (r.insteadYouHave) console.log(`  you have : ${r.insteadYouHave}`);
  if (r.fromResume) console.log(`  resume   : ${r.fromResume.slice(0, 100)}`);
  if (r.note) console.log(`  NOTE     : ${r.note}`);
  console.log(`  advice   : ${r.advice}`);
}

console.log(rule('SUMMARY'));
console.log(`[${mark(c.summary.verdict)}] ${c.summary.text}`);
if (c.summary.note) console.log(`      note: ${c.summary.note}`);

console.log(rule('SKILLS'));
for (const s of c.skills) {
  console.log(`[${mark(s.verdict)}] ${s.text}`);
  if (s.note) console.log(`      note: ${s.note}`);
}

console.log(rule('EXPERIENCE'));
for (const co of c.companies) {
  console.log(`\n${co.company} — ${co.role}`);
  console.log(`  ${co.header}`);
  for (const l of co.lines) {
    console.log(`  [${mark(l.verdict)}] ${l.text}`);
    if (l.note) console.log(`        note: ${l.note}`);
    if (l.question) console.log(`        ASK : ${l.question}`);
  }
}

console.log(rule('WHAT THE MODEL CHOSE NOT TO CARRY OVER'));
for (const d of c.dropped) console.log(`  - ${d.text}\n      ${d.why}`);

console.log(rule('VOICE'));
console.log(c.voice.length ? c.voice.join('\n') : 'no uniformity problems found');
const all = [c.summary, ...c.skills, ...c.companies.flatMap((x) => x.lines)]
  .map((l) => l.text)
  .filter(Boolean);
const problems = voiceProblems(all);
console.log(`banned words / result clauses across the whole document: ${problems.length}`);
for (const p of problems.slice(0, 8)) console.log(`  ${p.kind}: "${p.detail}" in ${p.line.slice(0, 80)}`);

// The checker deletes nothing, so this is everything the model wrote. The count
// above it is what a person would be asked to look at before sending it.
console.log(rule(`THE DOCUMENT — ${c.kept} verified, ${c.flagged} flagged, 0 removed`));
console.log(assembleRewrite(c, readShape(resumeText), new Set()));
console.log(rule('DONE'));
