/**
 * One real skills call and one real roles call, printed in full.
 *
 * Not a test: it spends money and needs a key. `npm test` globs tests/*.test.ts
 * only, so it cannot be reached from there.
 *
 *   npx tsx scripts/suggest-eval.mts <resume.txt> <job-key> <title> <company> [mode]
 */
import { readFileSync } from 'node:fs';

import { applyAdditions, documentFromShape } from '../src/tailor/additions.js';
import { describeJob } from '../src/tailor/jd.js';
import { readShape } from '../src/tailor/sections.js';
import { suggest } from '../src/tailor/suggest-run.js';
import { fullAsText } from '../src/tailor/suggest.js';
import { claimTokens, containsClaim } from '../src/tailor/edits.js';
import type { SuggestMode } from '../src/tailor/suggest.js';
import { voiceProblems } from '../src/tailor/voice.js';

const [resumePath, jobKey, title, company, modeArg] = process.argv.slice(2);
if (!resumePath || !jobKey) {
  console.error('usage: tsx scripts/suggest-eval.mts <resume.txt> <job-key> <title> <company> [skills|roles|both]');
  process.exit(1);
}
const ALL: SuggestMode[] = ['summary', 'full', 'skills', 'roles'];
const modes: SuggestMode[] = ALL.includes(modeArg as SuggestMode) ? [modeArg as SuggestMode] : ALL;

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
const shape = readShape(resumeText);

const jd = await describeJob({ key: jobKey, title: title ?? 'the role' });
if (!jd.ok) {
  console.error('no description:', jd.reason);
  process.exit(1);
}
console.log(rule('INPUT'));
console.log(`resume  : ${resumeText.length} chars, ${shape.companies.length} employers`);
console.log(`posting : ${jd.text.length} chars via ${jd.via}`);

const input = {
  resumeText,
  jobTitle: title ?? 'the role',
  company: company ?? '',
  jobDescription: jd.text,
};

for (const mode of modes) {
  console.log(rule(`${mode.toUpperCase()} — this spends money`));
  const started = Date.now();
  const out = await suggest(input, mode, { apiKey: key });
  console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s · ${out.note}`);
  if (out.needsAttention) console.log('NEEDS ATTENTION');

  if (mode === 'skills' && out.skills) {
    for (const s of out.skills.skills) {
      console.log(`\n  [ ] ${s.skill}`);
      if (s.fromPosting) console.log(`      they ask : "${s.fromPosting.slice(0, 90)}"`);
      console.log(`      ${s.intoLine ? 'that line becomes' : 'new line'} : ${s.newLine}`);
      if (s.why) console.log(`      why      : ${s.why.slice(0, 110)}`);
      // The check nobody else does: is this skill ALREADY in the resume? A list
      // of things they have is worse than no list.
      if (new RegExp(`\\b${s.skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(resumeText)) {
        console.log(`      !! ALREADY IN THE RESUME — this suggestion is noise`);
      }
    }

    // What the document looks like with every one of them ticked.
    const all = out.skills.skills.map((s) => ({ skill: s.skill, intoLine: s.intoLine, newLine: s.newLine }));
    const doc = applyAdditions(documentFromShape(shape), all, []);
    // The whole section, so a suggestion that had no existing line to join is
    // visible too — printing only the known labels hid exactly those.
    console.log(rule('SKILLS SECTION WITH ALL OF THEM TICKED'));
    const from = doc.indexOf('TECHNICAL SKILLS');
    const to = doc.indexOf('PROFESSIONAL EXPERIENCE');
    console.log(doc.slice(from, to > from ? to : undefined).trim());
  }

  if (mode === 'summary' && out.summary) {
    console.log(`
  YOURS NOW (${out.summary.original.length} chars)
  ${out.summary.original}`);
    for (const o of out.summary.options) {
      // A third longer is where the prompt says it stops being a light touch.
      const grew = o.text.length > out.summary.original.length * 1.34;
      console.log(`
  [ ] (${o.text.length} chars${grew ? '  !! A THIRD LONGER — NOT A LIGHT TOUCH' : ''})`);
      console.log(`      ${o.text}`);
      console.log(`      changed : ${o.changed}`);
      console.log(`      why     : ${o.why}`);
      // The budget the prompt sets: at most a quarter of the words changed.
      const a = out.summary.original.toLowerCase().split(/\W+/).filter(Boolean);
      const b = o.text.toLowerCase().split(/\W+/).filter(Boolean);
      const kept = a.filter((w) => b.includes(w)).length;
      const pct = a.length ? Math.round((1 - kept / a.length) * 100) : 0;
      console.log(`      ${pct}% of your words gone${pct > 25 ? '  !! OVER THE 25% BUDGET' : ''}`);
      for (const t of claimTokens(o.text)) {
        if (!containsClaim(resumeText, t)) console.log(`      !! "${t}" IS NOT IN THE RESUME`);
      }
    }
  }

  if (mode === 'full' && out.full) {
    const known = shape.companies.map((c) => c.header);
    console.log(`
  approach: ${out.full.approach}`);
    for (const h of known) {
      if (!out.full.companies.some((c) => c.header.trim() === h.trim())) {
        console.log(`  !! EMPLOYER MISSING OR ALTERED: ${h}`);
      }
    }
    for (const c of out.full.companies) {
      if (c.bullets.length === 0) console.log(`  !! ${c.header} HAS NO BULLETS`);
    }
    const text = fullAsText(out.full, shape);
    for (const t of claimTokens(text)) {
      if (!containsClaim(resumeText, t)) console.log(`  !! "${t}" IS NOT IN THE RESUME`);
    }
    console.log(rule('THE REWRITTEN RESUME'));
    console.log(text);
    const vp = voiceProblems([out.full.summary, ...out.full.companies.flatMap((c) => c.bullets)]);
    console.log(`
banned words / result clauses: ${vp.filter((x) => x.kind !== 'uniform shape').length}`);
    for (const x of vp.slice(0, 6)) console.log(`  ${x.kind}: "${x.detail}" in ${x.line.slice(0, 70)}`);
  }

  if (mode === 'roles' && out.roles) {
    const known = new Set(shape.companies.map((c) => c.name.toLowerCase()));
    for (const c of out.roles.companies) {
      const real = known.has(c.company.toLowerCase());
      console.log(`\n  ${c.company}${real ? '' : '   !! NOT AN EMPLOYER IN THE RESUME'}`);
      for (const b of c.bullets) {
        console.log(`    [ ] ${b.text}`);
        console.log(`        covers : ${b.skill}`);
        if (b.why) console.log(`        why    : ${b.why.slice(0, 110)}`);
        // Invented numbers are the one thing the prompt forbids outright.
        const nums = b.text.match(/\b\d[\d,.]*%?\b/g) ?? [];
        const made = nums.filter((n) => !resumeText.includes(n));
        if (made.length) console.log(`        !! NUMBER NOT IN THE RESUME: ${made.join(', ')}`);
      }
    }

    const all = out.roles.companies.flatMap((c) =>
      c.bullets.map((b) => ({ company: c.company, header: c.header, text: b.text })),
    );
    const doc = applyAdditions(documentFromShape(shape), [], all);
    console.log(rule('EXPERIENCE WITH ALL OF THEM TICKED'));
    console.log(doc.slice(doc.indexOf('PROFESSIONAL EXPERIENCE')));

    const problems = voiceProblems(all.map((a) => a.text));
    console.log(`\nbanned words / result clauses in the suggestions: ${problems.length}`);
    for (const p of problems.slice(0, 6)) console.log(`  ${p.kind}: "${p.detail}" in ${p.line.slice(0, 70)}`);
  }
}

console.log(rule('DONE'));
