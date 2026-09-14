import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  checkRequirements,
  describeTally,
  orderForReading,
  tally,
  type Requirement,
} from '../src/tailor/coverage.js';
import { assembleRewrite, checkRewrite, type RewriteAnswer } from '../src/tailor/rewrite.js';
import { readShape } from '../src/tailor/sections.js';

/**
 * Coverage, and the answer that makes the list worth reading.
 *
 * WHAT THIS REPLACED
 *
 * A list whose first eleven rows read NOT FOUND, on a real posting, for a
 * competent platform engineer. Two of them were not skills at all — "Hybrid work
 * in Boston, MA" and "US Citizenship or Green Card Holder status". Four more were
 * wrong in the way that matters:
 *
 *   OpenTofu   marked missing against a resume listing Terraform. OpenTofu is a
 *              FORK of Terraform, and the posting itself said "Terraform or
 *              OpenTofu".
 *   AWS        marked missing against a resume full of Azure.
 *   Datadog    marked missing against Splunk and AppInsights.
 *   Linux      marked missing, for somebody running Docker and Kubernetes.
 *
 * Huntr, the best-reviewed tool in this space, is praised for precisely the thing
 * that was absent: "semantic matching that evaluates substance, not just word
 * overlap", showing "which resume elements already match the role, even with
 * different phrasing".
 */

const NL = String.fromCharCode(10);

const RESUME = [
  'MADHUKAR ABBURI',
  'someone@example.com',
  'TECHNICAL SKILLS',
  'Cloud Technologies: Azure DevOps, Azure Kubernetes Services, Terraform, Ansible, Docker',
  'Programming Languages and Scripting: Python, Shell Scripting, Bash Scripting',
  'PROFESSIONAL EXPERIENCE',
  'LIFE BONDER, United States Feb 2024 - Present',
  'Software Engineer',
  'Built and containerized applications using Docker, orchestrated deployments on Kubernetes with Helm charts.',
  'Tracked application health using Splunk and AppInsights.',
].join(NL);

const req = (o: Partial<Requirement> = {}): Requirement => ({
  name: 'Kubernetes',
  need: 'must',
  answer: 'shown',
  fromPosting: 'You will run services on Kubernetes',
  fromResume:
    'Built and containerized applications using Docker, orchestrated deployments on Kubernetes with Helm charts.',
  insteadYouHave: '',
  advice: 'Lead with the Kubernetes work.',
  ...o,
});

// ---------------------------------------------------------------------------
// The answer that did not exist
// ---------------------------------------------------------------------------

test('YOU HAVE THE EQUIVALENT IS ITS OWN ANSWER, AND IT NAMES WHAT YOU HAVE', () => {
  // The row that changes what somebody does. "They want Datadog, you have Splunk
  // and AppInsights" belongs in a covering letter. "NOT FOUND" belongs nowhere.
  const [out] = checkRequirements(
    [
      req({
        name: 'Datadog dashboards and monitors',
        answer: 'adjacent',
        fromResume: '',
        insteadYouHave: 'Splunk and AppInsights',
      }),
    ],
    RESUME,
  );
  assert.equal(out!.answer, 'adjacent');
  assert.equal(out!.insteadYouHave, 'Splunk and AppInsights');
  assert.equal(out!.note, undefined);
});

test('THE EQUIVALENT IS CHECKED AS A CLAIM, NOT AS A QUOTE', () => {
  // The model names the equivalent in its own words — "Docker, Kubernetes, Helm
  // charts, Shell Scripting and Bash Scripting" — which is not a sentence lifted
  // out of the CV. Demanding a verbatim quote downgraded two CORRECT answers on
  // the first real run, so it is checked the way every other claim in this
  // codebase is: every technical name in it has to trace back.
  const real = checkRequirements(
    [
      req({
        name: 'Linux/Unix fundamentals',
        answer: 'adjacent',
        fromResume: '',
        insteadYouHave: 'Docker, Kubernetes, Helm charts, Shell Scripting and Bash Scripting',
      }),
    ],
    RESUME,
  );
  assert.equal(real[0]!.answer, 'adjacent', real[0]!.note);

  const invented = checkRequirements(
    [
      req({
        name: 'Event streaming',
        answer: 'adjacent',
        fromResume: '',
        insteadYouHave: 'Kafka and Cassandra clusters',
      }),
    ],
    RESUME,
  );
  assert.equal(invented[0]!.answer, 'unclear', 'a fabricated equivalent was accepted');
  assert.match(invented[0]!.note ?? '', /kafka/);
  assert.match(invented[0]!.note ?? '', /not in your resume/);
});

test('an equivalent that is not named at all is not an answer', () => {
  const [out] = checkRequirements(
    [req({ answer: 'adjacent', fromResume: '', insteadYouHave: '   ' })],
    RESUME,
  );
  assert.equal(out!.answer, 'unclear');
  assert.match(out!.note ?? '', /did not name it/);
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('WORK AUTHORISATION IS NOT A MISSING SKILL', () => {
  // "US Citizenship or Green Card Holder status" appeared in a list of missing
  // SKILLS, which is nonsense: it is a fact about a person, not a gap in their
  // CV, and nothing they can do to a resume changes it.
  const reqs = checkRequirements(
    [
      req({ name: 'US Citizenship or Green Card Holder', need: 'eligibility', answer: 'unclear', fromResume: '' }),
      req({ name: 'Hybrid work in Boston, MA', need: 'eligibility', answer: 'missing', fromResume: '' }),
      req({ name: 'Kubernetes' }),
    ],
    RESUME,
  );
  const t = tally(reqs);
  assert.equal(t.eligibility.length, 2);
  assert.equal(t.must.total, 1, 'an eligibility item was counted as a skill');
  assert.equal(t.must.missing, 0);
  // And it never carries resume evidence, because it is not about the resume.
  assert.equal(t.eligibility[0]!.fromResume, '');
});

// ---------------------------------------------------------------------------
// Counting and ordering
// ---------------------------------------------------------------------------

test('THE HEADLINE IS ARITHMETIC, NOT A SCORE', () => {
  const t = tally([
    req({ answer: 'shown' }),
    req({ answer: 'partial' }),
    req({ answer: 'adjacent' }),
    req({ answer: 'missing' }),
    req({ need: 'nice', answer: 'shown' }),
    req({ need: 'nice', answer: 'missing' }),
  ]);
  const line = describeTally(t);
  assert.match(line, /2 of 4 must-haves/);
  assert.match(line, /1 you have the equivalent of/);
  assert.match(line, /1 genuinely missing/);
  assert.match(line, /1 of 2 nice-to-haves/);
  assert.ok(!/%/.test(line), 'a percentage crept in — nobody can check a percentage');
});

test('gaps come first, and must-haves before nice-to-haves', () => {
  // A gap is the most useful line on the page. Burying it under the things the
  // candidate already has is how somebody reads the top three and stops.
  const ordered = orderForReading([
    req({ name: 'a', answer: 'shown' }),
    req({ name: 'b', need: 'nice', answer: 'missing' }),
    req({ name: 'c', answer: 'missing' }),
    req({ name: 'd', answer: 'adjacent', insteadYouHave: 'Terraform' }),
  ]);
  assert.deepEqual(ordered.map((r) => r.name), ['c', 'd', 'a', 'b']);
});

// ---------------------------------------------------------------------------
// Evidence, same standard as everywhere else
// ---------------------------------------------------------------------------

test('a claim of evidence that is not in the resume is downgraded', () => {
  const [out] = checkRequirements(
    [req({ fromResume: 'Ran a fleet of 4,000 Kubernetes nodes across three regions.' })],
    RESUME,
  );
  assert.equal(out!.answer, 'unclear');
  assert.equal(out!.fromResume, '');
});

test('a downgraded requirement is kept, because the employer still asked for it', () => {
  const out = checkRequirements([req({ fromResume: 'invented' })], RESUME);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, 'Kubernetes');
});

// ---------------------------------------------------------------------------
// Putting your own line back
// ---------------------------------------------------------------------------

const REWRITE_RESUME = [
  'NAME',
  'someone@example.com',
  'A summary about six years of .NET work.',
  'TECHNICAL SKILLS',
  'Cloud: Azure DevOps, Terraform, Docker',
  'PROFESSIONAL EXPERIENCE',
  'ACME, Remote Jan 2020 - Present',
  'Engineer',
  'Authored Terraform scripts to provision cloud environments.',
].join(NL);

const shape = readShape(REWRITE_RESUME);

const answer = (over: Partial<RewriteAnswer> = {}): RewriteAnswer => ({
  summary: 'A summary about six years of .NET work.',
  summaryWhy: 'unchanged',
  skills: [],
  companies: [
    {
      company: 'ACME',
      role: 'Engineer',
      header: 'ACME, Remote Jan 2020 - Present',
      bullets: [
        {
          text: 'Provisioned cloud environments with Terraform.',
          from: ['Authored Terraform scripts to provision cloud environments.'],
          why: 'leads with the provisioning work',
        },
      ],
    },
  ],
  dropped: [],
  requirements: [],
  ...over,
});

test('A REWRITTEN LINE REMEMBERS WHAT IT REPLACED', () => {
  // Every review of this category marks tools down in the same words: "no
  // selective approval — all changes apply wholesale". A rewrite you cannot
  // partly reject is one you have to take on trust.
  const checked = checkRewrite(answer(), REWRITE_RESUME);
  const line = checked.companies[0]!.lines[0]!;
  assert.equal(line.original, 'Authored Terraform scripts to provision cloud environments.');
});

test('REVERTING PUTS YOUR OWN SENTENCE BACK, NOT A BLANK', () => {
  const checked = checkRewrite(answer(), REWRITE_RESUME);
  const rewritten = checked.companies[0]!.lines[0]!.text;

  const taken = assembleRewrite(checked, shape, new Set(), new Set());
  assert.match(taken, /Provisioned cloud environments with Terraform/);

  const reverted = assembleRewrite(checked, shape, new Set(), new Set([rewritten]));
  assert.match(reverted, /Authored Terraform scripts to provision cloud environments/);
  assert.ok(!reverted.includes('Provisioned cloud environments'), 'both versions are in it');
});

test('reverting a line that replaced nothing removes it', () => {
  // The only honest reading of "undo" for a sentence that was not a rewrite of
  // anything. Putting an empty line in its place would leave a hole.
  const checked = checkRewrite(
    answer({
      companies: [
        {
          company: 'ACME',
          role: 'Engineer',
          header: 'ACME, Remote Jan 2020 - Present',
          bullets: [{ text: 'Provisioned cloud environments with Terraform.', from: [], why: 'x' }],
        },
      ],
    }),
    REWRITE_RESUME,
  );
  const out = assembleRewrite(
    checked,
    shape,
    new Set(),
    new Set(['Provisioned cloud environments with Terraform.']),
  );
  assert.ok(!out.includes('Provisioned cloud'));
  assert.ok(!/·\s*$/m.test(out), 'it left an empty bullet behind');
});

test('THE CHANGE LIST ONLY SHOWS LINES THAT ACTUALLY CHANGED', () => {
  // A rewrite that returned a line unaltered is not a change, and listing it
  // would bury the real ones.
  const checked = checkRewrite(answer(), REWRITE_RESUME);
  assert.equal(
    checked.summary.original.trim(),
    checked.summary.text.trim(),
    'the fixture summary should be unchanged',
  );
});

test('the workspace shows coverage above the changes', () => {
  // "Should I apply at all" is the larger question and goes first.
  const src = readFileSync(
    new URL('../app/_components/RewriteWorkspace.tsx', import.meta.url),
    'utf8',
  );
  const cov = src.indexOf('<Coverage');
  const chg = src.indexOf('<Changes');
  assert.ok(cov > 0 && chg > 0, 'one of the panels is missing');
  assert.ok(cov < chg, 'the change list is above the coverage');
});
