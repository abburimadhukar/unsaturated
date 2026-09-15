import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  coverage,
  describeCoverage,
  quoteIsInResume,
  verifySkillMatches,
  type SkillMatch,
} from '../src/tailor/analysis.js';
import { containsClaim, sameWordDifferentEnding } from '../src/tailor/edits.js';
import { parseAnswer } from '../src/tailor/run.js';
import { cleanResumeText, suspectedArtefacts } from '../src/ui/resume-clean.js';
import {
  diffHandEdits,
  handEditedLines,
  replayHandEdits,
} from '../src/tailor/hand-edits.js';

/**
 * The analysis, and the three bugs the first real model call exposed.
 *
 * Everything in this repo was proven against a fake until the feature was run
 * once, for real, against a real posting. That run is the reason this file
 * exists — it found more in thirteen seconds than the preceding thousand tests:
 *
 *   1. The rewrites were nearly worthless. Seven suggestions, the most
 *      substantial of which moved "React.js" two words earlier. The GAPS in the
 *      same response were excellent. So the analysis becomes the product.
 *
 *   2. With "Cut what doesn't matter" on, it deleted every mention of AI from the
 *      CV — for a company that builds autonomous aircraft swarms. It broke no
 *      rule: every rule was about not INVENTING, and this was a failure about
 *      what to KEEP.
 *
 *   3. The verifier flagged "diagnosed" as absent from a resume that said
 *      "diagnosing bottlenecks", making a person adjudicate a rewording.
 */

/**
 * Written as a code point rather than an escape.
 *
 * This project has repeatedly had a literal newline written into a string
 * literal where the two-character escape belonged — it compiles nowhere and is
 * invisible in a diff. There is nothing here to get wrong.
 */
const NL = String.fromCharCode(10);

const RESUME = [
  'MADHUKAR ABBURI',
  'Full Stack .NET Software Engineer with 6 years of experience.',
  'TECHNICAL SKILLS',
  'Cloud: Azure DevOps, Azure Kubernetes Services, Terraform, Docker',
  'PROFESSIONAL EXPERIENCE',
  'LIFE BONDER, United States Feb 2024 - Present',
  'Enhanced app performance using Dynatrace, diagnosing bottlenecks and resolving timeouts.',
  'Developed cloud-native microservices using .NET Core and Docker on AKS.',
].join('\n');

const match = (over: Partial<SkillMatch> = {}): SkillMatch => ({
  name: 'Kubernetes',
  kind: 'required',
  status: 'strong',
  jdEvidence: 'You will run services on Kubernetes',
  resumeEvidence: 'Developed cloud-native microservices using .NET Core and Docker on AKS.',
  action: 'Lead with the AKS work.',
  ...over,
});

// ---------------------------------------------------------------------------
// The evidence check
// ---------------------------------------------------------------------------

test('A CLAIM OF EVIDENCE IS CHECKED AGAINST THE RESUME', () => {
  // The check the whole analysis rests on. A model that says "strong — your CV
  // shows Kubernetes at scale" about a CV that says nothing of the sort is worse
  // than no analysis, because it reads as reassurance.
  const [ok] = verifySkillMatches([match()], RESUME);
  assert.equal(ok!.status, 'strong');

  const [bad] = verifySkillMatches(
    [match({ resumeEvidence: 'Ran a fleet of 4,000 Kubernetes nodes across three regions.' })],
    RESUME,
  );
  assert.equal(bad!.status, 'unknown', 'an invented quote was accepted as evidence');
  assert.equal(bad!.resumeEvidence, '');
  assert.match(bad!.note ?? '', /not in your resume/);
});

test('claiming evidence and quoting nothing is downgraded, not believed', () => {
  const [m] = verifySkillMatches([match({ resumeEvidence: '' })], RESUME);
  assert.equal(m!.status, 'unknown');
  assert.match(m!.note ?? '', /quoted nothing/);
});

test('A MISSING REQUIREMENT IS NEVER GIVEN EVIDENCE', () => {
  // A quote attached to "missing" is a contradiction, and the dangerous reading
  // of it is the one where the quote wins and the person believes they are
  // covered.
  const [m] = verifySkillMatches(
    [match({ status: 'missing', resumeEvidence: 'Developed cloud-native microservices' })],
    RESUME,
  );
  assert.equal(m!.status, 'missing');
  assert.equal(m!.resumeEvidence, '');
});

test('a downgraded requirement is kept, not dropped', () => {
  // It is still something the employer asked for. Dropping it would hide a
  // requirement, which is the one thing this list must never do.
  const out = verifySkillMatches([match({ resumeEvidence: 'invented' })], RESUME);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, 'Kubernetes');
});

test('a tidied quote still counts, a different quote does not', () => {
  // Models reflow whitespace and drop trailing clauses. Demanding a byte-exact
  // substring would discard evidence that is plainly there.
  assert.ok(
    quoteIsInResume(RESUME, 'Enhanced app  performance using Dynatrace, diagnosing bottlenecks'),
  );
  assert.ok(!quoteIsInResume(RESUME, 'Enhanced app performance using New Relic and Grafana'));
  // Too short to identify anything.
  assert.ok(!quoteIsInResume(RESUME, 'Azure'));
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('THE SUMMARY IS COUNTED, NOT WRITTEN BY THE MODEL', () => {
  // A model asked to summarise its own analysis rounds in the flattering
  // direction, and this is the sentence somebody reads instead of the list.
  const c = coverage([
    match({ status: 'strong' }),
    match({ status: 'strong' }),
    match({ status: 'partial' }),
    match({ status: 'missing' }),
    match({ kind: 'preferred', status: 'strong' }),
    match({ kind: 'preferred', status: 'missing' }),
  ]);
  assert.equal(c.required.total, 4);
  assert.equal(c.required.strong, 2);
  assert.equal(c.preferred.total, 2);

  const note = describeCoverage(c);
  assert.match(note, /2 of 4 required/);
  assert.match(note, /1 partly/);
  assert.match(note, /1 not found/);
  assert.match(note, /1 of 2 preferred/);
  assert.ok(!/%/.test(note), 'a percentage crept in — nobody can check a percentage');
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('AN UNREADABLE STATUS BECOMES UNKNOWN, NOT STRONG', () => {
  // Failing safe means failing towards "we could not confirm this", never
  // towards "you have it".
  const { requirements } = parseAnswer({
    requirements: [
      { name: 'Kafka', kind: 'nonsense', status: 'excellent', jdEvidence: 'x', resumeEvidence: 'y', action: 'z' },
    ],
  });
  assert.equal(requirements[0]!.status, 'unknown');
  assert.equal(requirements[0]!.kind, 'required');
});

test('a malformed analysis does not take the edits down with it', () => {
  const parsed = parseAnswer({
    requirements: 'not an array',
    domain: 42,
    edits: [{ original: 'a', replacement: 'b', reason: 'c', section: 'summary' }],
  });
  assert.deepEqual(parsed.requirements, []);
  assert.equal(parsed.domain.name, '');
  assert.equal(parsed.edits.length, 1);
});

test('a requirement with no name is dropped', () => {
  const { requirements } = parseAnswer({
    requirements: [{ name: '   ', kind: 'required', status: 'strong' }],
  });
  assert.deepEqual(requirements, []);
});

// ---------------------------------------------------------------------------
// The domain rule
// ---------------------------------------------------------------------------

test('THE PROMPT FORBIDS DELETING WHAT THE EMPLOYER ACTUALLY DOES', () => {
  // From the first real run: with "Cut what doesn't matter" on, the model removed
  // "Recently expanded focus into AI engineering… ML.NET, ONNX", "scalable
  // AI-backed APIs for financial applications" and "powered by NLP and LLM-based
  // content responses" — for a defence-autonomy employer. It saw "Full Stack
  // Software Engineer" in the title and optimised for those words.
  const src = readFileSync(new URL('../src/tailor/prompts.ts', import.meta.url), 'utf8');
  assert.match(src, /NEVER DELETE EVIDENCE OF WHAT THE EMPLOYER ACTUALLY DOES/);
  assert.match(src, /even when the/);
  assert.match(src, /job title does not mention it/);
});

test('the analysis always runs, whatever chips are chosen', () => {
  // It used to be behind the "Show me my gaps" chip, which was off by default —
  // so the useful half of the feature was off by default.
  const src = readFileSync(new URL('../src/tailor/prompts.ts', import.meta.url), 'utf8');
  assert.match(src, /ALWAYS_ANALYSE/);
  const build = src.slice(src.indexOf('export function buildMessages'));
  assert.match(build, /ALWAYS_ANALYSE,/);
  // Not inside a conditional on the chips.
  const line = build.split('\n').find((l) => l.includes('ALWAYS_ANALYSE,')) ?? '';
  assert.ok(!/\?|&&|chips/.test(line), 'the analysis is behind a condition again');
});

test('a metric may not be moved between employers', () => {
  const src = readFileSync(new URL('../src/tailor/prompts.ts', import.meta.url), 'utf8');
  assert.match(src, /Do not move a figure, tool or achievement from one employer to another/);
});

// ---------------------------------------------------------------------------
// The verifier's word-form false positive
// ---------------------------------------------------------------------------

test('THE SAME WORD WITH A DIFFERENT ENDING IS NOT A FABRICATION', () => {
  // From the real run: the CV said "diagnosing bottlenecks", the rewrite said
  // "Diagnosed bottlenecks", and the verifier told the person their own resume
  // did not contain it. That noise is what teaches somebody to click through
  // warnings without reading them — which is how a real fabrication gets in.
  assert.ok(containsClaim(RESUME, 'diagnosed'));
  assert.ok(containsClaim(RESUME, 'resolved'));
});

test('and a genuine fabrication still fails', () => {
  // Terms genuinely absent from RESUME. An earlier version of this test listed
  // "kubernetes" and "terraform", both of which the fixture's skills line
  // actually contains — so it was asserting that a true statement was false, and
  // would have passed for the wrong reason if the loosening had gone too far.
  for (const invented of ['kafka', 'postgresql', 'graphql', 'kotlin', 'rabbitmq']) {
    assert.ok(!containsClaim(RESUME, invented), `${invented} was accepted`);
  }
  // And the inflection fallback specifically must not admit a tool the resume
  // does not name, however close it looks to one that it does.
  const noK8s = 'Deployed services with Docker and Ansible.';
  assert.ok(!containsClaim(noK8s, 'kubernetes'));
  assert.ok(!containsClaim(noK8s, 'dockerised'));
});

test('NUMBERS ARE NEVER LOOSENED BY THE WORD-FORM RULE', () => {
  // Numbers are the dangerous half. The fallback is letters-only on purpose.
  assert.ok(!sameWordDifferentEnding('we saved 2040 hours', '40'));
  assert.ok(!containsClaim('in the year 2040', '40'));
  assert.ok(!sameWordDifferentEnding('ci/cd pipelines', 'ci/cd'));
});

test('a bare stem cannot match a longer unrelated word', () => {
  // "kafka" has no ending to strip, so it never reaches the fallback and cannot
  // pass on a resume mentioning "kafkaesque".
  assert.ok(!sameWordDifferentEnding('a kafkaesque process', 'kafka'));
  assert.ok(!sameWordDifferentEnding('docker images', 'dock'));
});

// ---------------------------------------------------------------------------
// Converter damage
// ---------------------------------------------------------------------------

test('SQUASHED LETTERS ARE PUT BACK, SO A KEYWORD SEARCH MATCHES', () => {
  // A real CV arrived with "eﬃciency" — one character, U+FB03, that looks like
  // f-f-i. A recruiter searching for "efficiency" does not match it and nothing
  // on the page says so.
  const out = cleanResumeText('Improved release efﬁciency and streamlined workﬂows.');
  assert.match(out.text, /efficiency/);
  assert.match(out.text, /workflows/);
  assert.equal(out.repairs.length, 1);
  assert.match(out.repairs[0]!, /squashed letter/);
});

test("A CONVERTER'S OBJECT IDS ARE REPORTED AND LEFT WHERE THEY ARE", () => {
  // They used to be deleted. See the next two tests for what that ate.
  const raw = [
    'MADHUKAR ABBURI',
    'usa - someone@example.com',
    'A summary line.',
    'TECHNICAL SKILLS',
    '25400050782',
    'Cloud: Azure, Docker',
    'EDUCATION',
    '25400046444',
  ].join('\n');
  const out = cleanResumeText(raw);
  assert.ok(out.text.includes('25400050782'), 'a line was deleted from the CV');
  assert.ok(out.text.includes('25400046444'), 'a line was deleted from the CV');
  assert.match(out.text, /Cloud: Azure, Docker/);

  // Reported as something to look at, never as something already done.
  assert.equal(out.repairs.length, 0, 'it claimed to have repaired something');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0]!, /bare digits/);
  assert.match(out.warnings[0]!, /Nothing has been removed/);
  // Named by line number, so they can be found.
  assert.match(out.warnings[0]!, /5, 8/);
});

test('A PHONE NUMBER BELOW THE HEADER IS NOT AN ARTEFACT, AND USED TO BE DELETED', () => {
  // The bug, reported by the owner as "my resume is clean, your code is not".
  // The rule was "eight or more bare digits below line four", so a clean CV whose
  // header ran to five lines lost its phone number — and was told a converter had
  // left stray digits in a file no converter had ever touched.
  const clean = [
    'JANE SMITH',
    'Senior Platform Engineer',
    'London, United Kingdom',
    'jane.smith@example.com',
    '07700900123',
    '',
    'EXPERIENCE',
    'ACME, London 2021 - Present',
  ].join('\n');
  const out = cleanResumeText(clean);
  assert.ok(out.text.includes('07700900123'), 'it ate a phone number');
  assert.deepEqual(out.repairs, []);
  assert.deepEqual(out.warnings, [], 'it complained about a clean CV');
});

test('ONE LONG NUMBER IS A NUMBER; A REPEATED PATTERN IS AN ARTEFACT', () => {
  // The evidence in the real case was never "a long number appeared". It was that
  // three appeared, all eleven digits, all beginning 254000, one under each
  // heading. A lone certification or reference number is nobody's object id.
  const lone = ['A', 'B', 'C', 'D', 'CERTIFICATIONS', '20240517443', 'AWS SA'].join('\n');
  assert.deepEqual(suspectedArtefacts(lone), [], 'a certification number was flagged');

  const pattern = ['A', 'B', 'C', 'D', '25400050782', 'x', '25400046444'].join('\n');
  assert.deepEqual(
    suspectedArtefacts(pattern).map((a) => a.at),
    [5, 7],
  );

  // Two long numbers that share nothing are two numbers.
  const unrelated = ['A', 'B', 'C', 'D', '07700900123', 'x', '4045667011'].join('\n');
  assert.deepEqual(suspectedArtefacts(unrelated), []);

  // Still exempt at the top, and still too short to matter anywhere.
  assert.deepEqual(suspectedArtefacts(['25400050782', '25400046444'].join('\n')), []);
  assert.deepEqual(suspectedArtefacts(['A', 'B', 'C', 'D', '2024', 'x', '2018'].join('\n')), []);
});

test('a lost # is reported and never guessed at', () => {
  // The same conversion turned "C#" into "C", and the model duly reported "the
  // resume lists C, but not C++". A lost character cannot be recovered from the
  // text that survived it, and guessing which bare "C" was once "C#" would be
  // inventing — which is the one thing this codebase does not do.
  const out = cleanResumeText('Languages: ASP.NET, C, SQL, Python');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0]!, /C#/);
  assert.match(out.text, /, C,/, 'it corrected the text instead of reporting it');

  // Judged line by line. "C, C#, C++" on one line is correct and deliberate, and
  // the C# beside the bare C is what says so.
  assert.equal(cleanResumeText('Languages: ASP.NET, C, C#, C++').warnings.length, 0);

  // AND SO DOES C++ ON ITS OWN. Somebody who wrote "C++" plainly knows to write
  // the suffix when they mean one, so the bare C beside it is deliberate. Only
  // checking for C# fired on every clean CV listing C and C++ next to ASP.NET,
  // and told its owner a converter had eaten a character that was never there.
  assert.deepEqual(
    cleanResumeText('Programming Languages: C, C++, Java, Python\nFrameworks: ASP.NET MVC').warnings,
    [],
    'a clean "C, C++" list was reported as converter damage',
  );

  // AND IT MUST STILL FIRE when the document says C# somewhere ELSE. The real
  // resume had "ASP.NET, C, SQL" in its skills line and "using C# and VB.NET" in
  // a bullet further down — writing it correctly in one place and bare in another
  // is stronger evidence a character was lost, not weaker. An earlier version
  // asked whether the whole document contained C# and stayed silent on exactly
  // the case it was written for.
  const split = cleanResumeText(
    ['Programming Languages: ASP.NET, C, SQL', 'Built the logic using C# and VB.NET.'].join(NL),
  );
  assert.equal(split.warnings.length, 1, 'silent on the case it exists for');
});

// ---------------------------------------------------------------------------
// Hand edits
// ---------------------------------------------------------------------------

const DOC = ['Alpha', 'Bravo', 'Charlie', 'Delta'].join('\n');

test('MANUAL EDITS SURVIVE ACCEPTING ANOTHER SUGGESTION', () => {
  // The bug, exactly. The document is rebuilt from the stored original every time
  // a suggestion is accepted, so a sentence somebody typed was silently thrown
  // away by their next click — and it threw away precisely what the page tells
  // people to do.
  const ops = diffHandEdits(DOC, ['Alpha', 'Bravo in my own words', 'Charlie', 'Delta'].join('\n'));
  assert.deepEqual(ops, [{ kind: 'replace', from: 'Bravo', to: 'Bravo in my own words' }]);

  // A rebuild where a suggestion changed a DIFFERENT line.
  const rebuilt = ['Alpha', 'Bravo', 'Charlie rewritten by the model', 'Delta'].join('\n');
  const out = replayHandEdits(rebuilt, ops);
  assert.match(out.text, /Bravo in my own words/);
  assert.match(out.text, /Charlie rewritten by the model/);
  assert.equal(out.applied, 1);
  assert.equal(out.lost.length, 0);
});

test('manual edits survive skipping, too', () => {
  const ops = diffHandEdits(DOC, ['Alpha', 'Bravo', 'Charlie', 'Delta mine'].join('\n'));
  const out = replayHandEdits(DOC, ops);
  assert.match(out.text, /Delta mine/);
});

test('a line the person ADDED comes back in the right place', () => {
  const ops = diffHandEdits(DOC, ['Alpha', 'Bravo', 'Brand new line', 'Charlie', 'Delta'].join('\n'));
  const out = replayHandEdits(DOC, ops);
  assert.equal(out.text, ['Alpha', 'Bravo', 'Brand new line', 'Charlie', 'Delta'].join('\n'));
});

test('a line the person DELETED stays deleted', () => {
  const ops = diffHandEdits(DOC, ['Alpha', 'Charlie', 'Delta'].join('\n'));
  const out = replayHandEdits(DOC, ops);
  assert.ok(!out.text.includes('Bravo'));
});

test('AN EDIT IS NEVER REPLAYED TWICE', () => {
  // Replaying onto a document that already has the person's wording must be a
  // no-op, not a second copy of their sentence.
  const ops = diffHandEdits(DOC, ['Alpha', 'Bravo mine', 'Charlie', 'Delta'].join('\n'));
  const once = replayHandEdits(DOC, ops);
  const twice = replayHandEdits(once.text, ops);
  assert.equal(twice.text, once.text);
});

test('AN EDIT WHOSE LINE IS GONE IS REPORTED, NOT PUT SOMEWHERE APPROXIMATE', () => {
  // Guessing where a sentence belongs is how a CV ends up with a bullet under the
  // wrong employer.
  const ops = diffHandEdits(DOC, ['Alpha', 'Bravo mine', 'Charlie', 'Delta'].join('\n'));
  const rebuilt = ['Alpha', 'Something else entirely', 'Charlie', 'Delta'].join('\n');
  const out = replayHandEdits(rebuilt, ops);
  assert.equal(out.lost.length, 1);
  assert.ok(!out.text.includes('Bravo mine'));
  assert.ok(!out.text.includes('Bravo mine'), 'it was forced in anyway');
});

test('the sheet can mark which lines the person wrote', () => {
  const ops = diffHandEdits(DOC, ['Alpha', 'Bravo mine', 'Charlie', 'Delta'].join('\n'));
  const out = replayHandEdits(DOC, ops);
  assert.deepEqual([...handEditedLines(out.text, ops)], [1]);
});

test('THE DOWNLOAD IS THE DOCUMENT ON SCREEN', () => {
  // Copy, the .docx and the PDF all render the text the person is looking at —
  // hand edits, ticked suggestions and all. A download that quietly differs from
  // the preview is the worst outcome this feature has.
  //
  // This used to read use-tailor-session.ts, the feed card's own session. That
  // card now links to the full page instead of opening a second tailoring
  // feature under the post, so the invariant moved to the one that survived.
  const src = readFileSync(
    new URL('../app/_components/use-rewrite.ts', import.meta.url),
    'utf8',
  );
  // layoutResume, not readResume: the PDF is now built from the same classifier
  // the .docx is, so the two files cannot be different documents.
  for (const fn of ['navigator.clipboard?.writeText(', 'docxBlob(', 'layoutResume(']) {
    const at = src.indexOf(fn);
    assert.ok(at > 0, `${fn} is gone`);
    const call = src.slice(at, src.indexOf(')', at));
    assert.match(call, /document_/, `${fn} does not use the document on screen`);
  }
});
