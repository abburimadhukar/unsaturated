/**
 * One real whole-resume rewrite, printed in full.
 *
 * Not a test: it spends money and needs a key. `npm test` globs tests/*.test.ts
 * only, so it cannot be reached from there.
 *
 *   npx tsx scripts/rewrite-eval.mts <resume.txt> <job-key> <title> <company> [presets]
 */
import { readFileSync } from 'node:fs';

import { describeJob } from '../src/tailor/jd.js';
import { assembleRewrite } from '../src/tailor/rewrite.js';
import { rewriteResume } from '../src/tailor/rewrite-run.js';
import { readShape } from '../src/tailor/sections.js';
import { voiceProblems } from '../src/tailor/voice.js';

const [resumePath, jobKey, title, company, presetArg] = process.argv.slice(2);
if (!resumePath || !jobKey) {
  console.error('usage: tsx scripts/rewrite-eval.mts <resume.txt> <job-key> <title> <company> [presets]');
  process.exit(1);
}
const presets = (presetArg ?? 'plain,depth,keywords').split(',').filter(Boolean);

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
console.log(`presets : ${presets.join(', ')}`);

console.log(rule('REWRITING — this spends money'));
const started = Date.now();
const result = await rewriteResume(
  {
    resumeText,
    jobTitle: title ?? 'the role',
    company: company ?? '',
    jobDescription: jd.text,
    presets,
  },
  { apiKey: key },
);
console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`note: ${result.note}`);
if (result.needsAttention) console.log('NEEDS ATTENTION');
if (!result.checked) process.exit(1);
const c = result.checked;

const mark = (v: string) => (v === 'kept' ? 'OK ' : v === 'ask' ? 'ASK' : 'DROP');

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

console.log(rule('DROPPED'));
for (const d of c.dropped) console.log(`  - ${d.text}\n      ${d.why}`);

console.log(rule('VOICE'));
console.log(c.voice.length ? c.voice.join('\n') : 'no uniformity problems found');
const kept = [
  c.summary,
  ...c.skills,
  ...c.companies.flatMap((x) => x.lines),
]
  .filter((l) => l.verdict !== 'dropped')
  .map((l) => l.text);
const problems = voiceProblems(kept);
console.log(`banned words / result clauses in what survived: ${problems.length}`);
for (const p of problems.slice(0, 8)) console.log(`  ${p.kind}: "${p.detail}" in ${p.line.slice(0, 80)}`);

console.log(rule('THE DOCUMENT (verified lines only)'));
console.log(assembleRewrite(c, readShape(resumeText), new Set()));
console.log(rule('DONE'));
