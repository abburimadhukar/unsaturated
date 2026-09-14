/**
 * One real tailoring run, against the real model.
 *
 * WHY THIS EXISTS
 *
 * Every test in this repo proves the tailoring pipeline against a fake. That is
 * the right way to test it — a paid call in a test suite is a bill and a flake —
 * but it means nothing here has ever shown what the model ACTUALLY writes. The
 * prompt could be ignored, the JSON could arrive in a shape the parser tolerates
 * but nobody wants, the edits could read like a machine wrote them. None of that
 * is visible from a fake.
 *
 * So this runs the real thing once and prints all of it: what was sent, what came
 * back, what the verifier made of it, and what it cost.
 *
 * DELIBERATELY NOT A TEST
 *
 * It spends money and needs a key, so it is a script that must be asked for by
 * name. `npm test` must never reach it.
 *
 *   npx tsx scripts/tailor-eval.mts <resume.txt> <job-key> [chip,chip]
 *
 * Reads OPENAI_API_KEY from the environment or .dev.vars.
 */
import { readFileSync } from 'node:fs';

import { describeJob } from '../src/tailor/jd.js';
import { buildMessages } from '../src/tailor/prompts.js';
import { tailor, TAILOR_MODEL } from '../src/tailor/run.js';

const [resumePath, jobKey, chipArg, titleArg] = process.argv.slice(2);
const jobTitle = titleArg ?? 'Software Engineer';
if (!resumePath || !jobKey) {
  console.error('usage: tsx scripts/tailor-eval.mts <resume.txt> <job-key> [chips]');
  process.exit(1);
}
const chips = (chipArg ?? 'mirror,lead').split(',').filter(Boolean);

// --- the key, from the environment or the local dev file ---------------------
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
    // No dev file; fall through to the error below.
  }
  return '';
}

const key = apiKey();
if (!key) {
  console.error('No OPENAI_API_KEY. Put it in .dev.vars (gitignored) or the environment.');
  process.exit(1);
}

const rule = (s: string) => `\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`;

const resumeText = readFileSync(resumePath, 'utf8');
console.log(rule('RESUME'));
console.log(`${resumeText.length} characters, ${resumeText.split('\n').length} lines`);

// --- the posting, fetched live from the employer -----------------------------
console.log(rule('JOB POSTING — fetched live'));
const jd = await describeJob({ key: jobKey, title: jobTitle });
if (!jd.ok) {
  console.error('no description came back:', jd.reason);
  process.exit(1);
}
console.log(`via ${jd.via} · ${jd.text.length} characters`);
console.log(`\n--- first 600 characters ---\n${jd.text.slice(0, 600)}…`);

// --- exactly what the model is sent ------------------------------------------
const messages = buildMessages({
  resumeText,
  jobTitle,
  jobDescription: jd.text,
  chips,
});
console.log(rule('SYSTEM MESSAGE'));
console.log(messages.system);
console.log(rule('USER MESSAGE — structure'));
console.log(
  messages.user
    .split('\n')
    .map((l) => (l.startsWith('===') ? l : null))
    .filter(Boolean)
    .join('\n'),
);
console.log(`\nchips understood: ${messages.used.map((c) => c.label).join(', ') || '(none)'}`);
console.log(`user message: ${messages.user.length} characters`);
console.log(`\n--- the WHAT TO DO section, verbatim ---`);
console.log(messages.user.slice(messages.user.indexOf('=== WHAT TO DO ===')));

// --- the call ----------------------------------------------------------------
console.log(rule(`CALLING ${TAILOR_MODEL} — this spends money`));
const started = Date.now();
const result = await tailor(
  { resumeText, jobTitle, jobDescription: jd.text, chips },
  { apiKey: key },
);
const took = Date.now() - started;

console.log(`took ${(took / 1000).toFixed(1)}s`);
console.log(`note: ${result.note}`);
console.log(`model: ${result.model}`);
if (result.needsAttention) console.log('NEEDS ATTENTION — a person must fix something');

// --- the analysis ------------------------------------------------------------
console.log(rule('DOMAIN'));
console.log(`${result.domain.name || '(none read)'}`);
if (result.domain.signals.length) console.log(`signals: ${result.domain.signals.join(', ')}`);

console.log(rule('COVERAGE'));
console.log(result.coverageNote || '(no requirements returned)');

console.log(rule('REQUIREMENTS'));
for (const r of result.requirements) {
  const tag = { strong: 'STRONG ', partial: 'PARTIAL', missing: 'MISSING', unknown: 'UNKNOWN' }[r.status];
  console.log(`
[${tag}] ${r.kind.toUpperCase()} - ${r.name}`);
  console.log(`  jd     : ${r.jdEvidence}`);
  if (r.resumeEvidence) console.log(`  resume : ${r.resumeEvidence}`);
  if (r.note) console.log(`  NOTE   : ${r.note}`);
  console.log(`  action : ${r.action}`);
}

// --- what came back ----------------------------------------------------------
console.log(rule('VERDICTS'));
console.log(
  `${result.accepted} verified · ${result.flagged} need judgement · ${result.rejected} discarded`,
);

for (const [i, c] of result.edits.entries()) {
  const mark = c.verdict === 'accepted' ? 'OK  ' : c.verdict === 'flagged' ? 'ASK ' : 'DROP';
  console.log(`\n[${mark}] ${i + 1}. ${c.edit.section || '(no section)'}`);
  console.log(`  was : ${c.edit.original}`);
  console.log(`  now : ${c.edit.replacement}`);
  console.log(`  why : ${c.edit.reason}`);
  if (c.verdict !== 'accepted') console.log(`  note: ${c.note}`);
  const grew = c.edit.replacement.length - c.edit.original.length;
  console.log(`  len : ${c.edit.original.length} -> ${c.edit.replacement.length} (${grew >= 0 ? '+' : ''}${grew})`);
}

console.log(rule('GAPS'));
if (result.gaps.length === 0) console.log('(none reported)');
for (const g of result.gaps) console.log(`  · ${g}`);

console.log(rule('DONE'));
