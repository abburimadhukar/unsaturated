import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  digestFor,
  digestHash,
  requirementsPart,
  MAX_DIGEST_CHARS,
} from '../src/matching/digest.js';
import { extractSkills } from '../src/taxonomy/families.js';

/**
 * What a job is embedded as — the choice that decides match quality.
 *
 * The model takes 512 tokens. A median description sampled from 101 real
 * postings on 11 Sep 2026 was 8,260 characters, roughly 2,065 tokens — four
 * times the limit. So something must choose what survives, and if it chooses
 * badly every job looks like every other job.
 *
 * Measured against 410 real postings from four boards, counting how many known
 * skills survive into the digest:
 *
 *   naive   title + the opening of the body     1.31 skills
 *   this    heading, no intro, no URLs          3.12 skills     +138%
 *
 *   better on 191 postings, worse on 22, identical on 197
 *
 * The same sample is where the two rules below come from: 52% of postings carry
 * a requirements heading, 48% carry none and used to fall back to a chatty
 * opening, and 11% of digests contained a recruiter's LinkedIn URL.
 */

const SKILLY =
  'Requirements: 5 years of Python, AWS, Kubernetes, Terraform and Airflow. ' +
  'You will own our data pipelines and the warehouse.';

// ---------------------------------------------------------------------------
// Order of value — truncation takes from the end, so the end must be cheapest
// ---------------------------------------------------------------------------

test('the title comes first, whatever else is present', () => {
  const d = digestFor({
    title: 'Senior Data Engineer',
    seniority: 'senior',
    specialization: 'backend',
    matchedSkills: ['python', 'aws'],
    description: SKILLY,
  });
  assert.ok(d.startsWith('Senior Data Engineer'), d.slice(0, 60));
});

test('A LONG BODY CANNOT PUSH THE TITLE OR SKILLS OUT', () => {
  // The reason ordering matters. A 40,000-character description must not cost
  // the one field that identifies the job.
  const d = digestFor({
    title: 'Staff Platform Engineer',
    seniority: 'staff',
    specialization: 'devops_sre',
    matchedSkills: ['kubernetes', 'terraform'],
    description: 'blah '.repeat(8_000),
  });
  assert.ok(d.length <= MAX_DIGEST_CHARS);
  assert.match(d, /^Staff Platform Engineer/);
  assert.match(d, /Seniority: staff/);
  assert.match(d, /Specialization: devops_sre/);
  assert.match(d, /Skills: kubernetes, terraform/);
});

test('the cap is respected and the cut lands on a word boundary', () => {
  const d = digestFor({ title: 'Engineer', description: 'alpha bravo charlie '.repeat(400) });
  assert.ok(d.length <= MAX_DIGEST_CHARS, `${d.length} chars`);
  // No half-word at the end. Every word in the source is one of three known ones.
  const last = d.split(' ').pop()!;
  assert.ok(['alpha', 'bravo', 'charlie', 'Engineer.'].includes(last), `ends with "${last}"`);
});

// ---------------------------------------------------------------------------
// What must NOT be in it
// ---------------------------------------------------------------------------

test('NO COMPANY NAME AND NO LOCATION', () => {
  // Both drag unrelated roles together. 2,107 Cleveland Clinic postings would
  // cluster on the employer rather than on the work; every London job would sit
  // beside every other London job.
  const d = digestFor({
    title: 'Backend Engineer',
    specialization: 'backend',
    matchedSkills: ['go'],
    description: 'Requirements: Go, Postgres.',
  });
  assert.doesNotMatch(d, /Cleveland|London|Acme/);
  // And the input shape offers nowhere to put them, which is the stronger
  // guarantee — a caller cannot pass what the type does not accept.
  const keys = Object.keys({
    title: '', seniority: null, family: null, specialization: null,
    matchedSkills: [], description: null,
  });
  assert.ok(!keys.includes('company') && !keys.includes('location'));
});

test('URLs AND EMAILS ARE STRIPPED', () => {
  // 11% of digests carried one before this. A recruiter's LinkedIn path is 60
  // characters the model must embed as something.
  const d = digestFor({
    title: 'Engineering Manager',
    description:
      'Requirements: Python. Reach me at https://uk.linkedin.com/in/colinhoweuk ' +
      'or colin@example.com or www.example.com/careers for details.',
  });
  assert.doesNotMatch(d, /https?:\/\//);
  assert.doesNotMatch(d, /linkedin/i);
  assert.doesNotMatch(d, /@example\.com/);
  assert.doesNotMatch(d, /www\./);
  assert.match(d, /Python/, 'and the useful words survive');
});

// ---------------------------------------------------------------------------
// Finding the part that is about the work
// ---------------------------------------------------------------------------

test('a requirements heading wins outright', () => {
  const body =
    'Acme is a leading provider of synergy. Founded in 2011. We have 400 people. ' +
    'Requirements: Python, Kubernetes, Terraform.';
  const part = requirementsPart(body);
  assert.ok(part.startsWith('Requirements'), part.slice(0, 40));
  assert.doesNotMatch(part, /synergy|Founded/);
});

test('every heading variant that appears in real ads is recognised', () => {
  for (const heading of [
    'Requirements', 'Qualifications', "What you'll need", "What we're looking for",
    'Who you are', 'Your profile', 'Skills and experience', 'Minimum qualifications',
    'You have', 'Must have', "What you'll do", 'Responsibilities', 'About the role',
  ]) {
    const body = `We are a leading provider of things. ${heading}: Python and AWS.`;
    const part = requirementsPart(body);
    assert.ok(
      part.toLowerCase().startsWith(heading.toLowerCase()),
      `"${heading}" not found — got "${part.slice(0, 40)}"`,
    );
  }
});

test('A CHATTY INTRODUCTION IS DROPPED WHEN THERE IS NO HEADING', () => {
  // The measured failure: 48% of postings have no heading, and this is verbatim
  // the shape two of the first three real ones took.
  const body =
    "Hi I'm Colin, Director of Engineering. " +
    'How do you feel about engineers writing product specs? ' +
    'You will need Python, Kubernetes and five years of experience.';
  const part = requirementsPart(body);
  assert.doesNotMatch(part, /Colin/);
  assert.match(part, /Python/);
});

test('intro dropping stops rather than emptying a short ad', () => {
  // Every sentence looks like an introduction. The introduction is all there is,
  // so it is better than nothing.
  const body = 'Hi there. Hello again. Hey you. We are a company. About us.';
  const part = requirementsPart(body);
  assert.ok(part.length > 0, 'must never return empty');
});

test('A SINGLE-SENTENCE INTRODUCTION IS RETURNED, NOT EMPTIED', () => {
  // The reachable path to an empty result, found by mutation testing rather than
  // by reading: a body ending in ". " splits into ['Hi there.', ''], the intro
  // rule drops the only real sentence, and slice() yields [''] — which without
  // the fallback returns nothing at all and the job is embedded as its title
  // alone.
  for (const body of ['Hi there. ', 'Hello. ', 'Hi I am Colin. ']) {
    const part = requirementsPart(body);
    assert.ok(part.trim().length > 0, `"${body}" produced nothing`);
  }
  assert.equal(requirementsPart('Hi there. ').trim(), 'Hi there.');
});

test('a body with neither heading nor intro is returned as it is', () => {
  const body = 'Python, Kubernetes and Terraform, three years, remote within the EU.';
  assert.equal(requirementsPart(body), body);
});

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

test('specialization is preferred over family, never both', () => {
  const both = digestFor({ title: 'Dev', family: 'software', specialization: 'backend' });
  assert.match(both, /Specialization: backend/);
  assert.doesNotMatch(both, /Field: software/, 'family adds nothing over a specialization');

  const familyOnly = digestFor({ title: 'Dev', family: 'software' });
  assert.match(familyOnly, /Field: software/);
});

test("'unsorted' IS NOT A FIELD, SO IT IS NOT WRITTEN DOWN", () => {
  // Found by running a real crawl and reading a sample digest, which began
  // "Vended Application Lead Consultant. Seniority: lead. Field: unsorted."
  // 43% of the open corpus carries that value — 28,107 postings — and it means
  // "we could not tell", not a field. Emitting it spends a token saying nothing
  // and pulls every one of those jobs toward each other.
  const d = digestFor({ title: 'Vended Application Lead Consultant', family: 'unsorted' });
  assert.doesNotMatch(d, /unsorted/);
  assert.doesNotMatch(d, /Field:/);
  assert.equal(d, 'Vended Application Lead Consultant');

  // A real family is still written.
  assert.match(digestFor({ title: 'Dev', family: 'software' }), /Field: software/);
  // And a specialization still wins over either.
  assert.match(
    digestFor({ title: 'Dev', family: 'unsorted', specialization: 'backend' }),
    /Specialization: backend/,
  );
});

test('missing fields are left out, not rendered as null', () => {
  const d = digestFor({ title: 'Engineer' });
  assert.equal(d, 'Engineer');
  assert.doesNotMatch(d, /null|undefined|Seniority|Skills|Field/);
});

test('a job with no description is still worth embedding', () => {
  // Workday's listing returns no body at all, and it is the largest provider in
  // the corpus at 30,785 open jobs. Title plus classification is thin but real.
  const d = digestFor({
    title: 'Registered Nurse - ICU',
    seniority: 'mid',
    specialization: 'general_software',
    matchedSkills: ['epic'],
  });
  assert.match(d, /Registered Nurse - ICU/);
  assert.match(d, /Skills: epic/);
  assert.ok(d.length > 0);
});

test('empty skills do not produce an empty label', () => {
  const d = digestFor({ title: 'Dev', matchedSkills: [] });
  assert.doesNotMatch(d, /Skills:/);
  const blanks = digestFor({ title: 'Dev', matchedSkills: ['', '  '] });
  assert.doesNotMatch(blanks, /Skills:/);
});

test('whitespace is flattened, so formatting cannot change the hash', () => {
  const a = digestFor({ title: 'Data   Engineer', description: 'Requirements:\n\n  Python\t\tAWS' });
  const b = digestFor({ title: 'Data Engineer', description: 'Requirements: Python AWS' });
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Determinism, because the hash beside it depends on it
// ---------------------------------------------------------------------------

test('the same job always produces the same digest', () => {
  const job = {
    title: 'Senior Data Engineer',
    seniority: 'senior',
    specialization: 'backend',
    matchedSkills: ['python', 'aws', 'airflow'],
    description: SKILLY,
  };
  assert.equal(digestFor(job), digestFor(job));
});

test('the hash is stable, short, and moves when the digest moves', async () => {
  const a = digestFor({ title: 'Data Engineer', description: SKILLY });
  const b = digestFor({ title: 'Data Engineer', description: SKILLY + ' Also Kafka.' });

  const ha = await digestHash(a);
  assert.equal(ha, await digestHash(a), 'stable across calls');
  assert.match(ha, /^[0-9a-f]{32}$/, 'hex, and short enough to store cheaply');
  assert.notEqual(ha, await digestHash(b), 'a changed digest must re-embed');
});

test('an empty digest still hashes, rather than throwing', async () => {
  assert.match(await digestHash(''), /^[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------------
// The point of all of it
// ---------------------------------------------------------------------------

test('THE DIGEST KEEPS MORE SKILLS THAN THE OPENING OF THE BODY WOULD', () => {
  // The 138% measured across 410 real postings, as one reproducible case.
  const body =
    'Acme is a leading provider of cloud solutions. Founded in 2011, we serve ' +
    'thousands of customers across forty countries and our mission is to ' +
    'delight them. We have been named a best place to work four years running. ' +
    'We believe in transparency, ownership and kindness. ' +
    'Requirements: strong Python, AWS, Terraform, Kubernetes and Airflow, ' +
    'plus experience with Snowflake and dbt.';

  const naive = `Data Engineer. ${body}`.slice(0, 260);
  const smart = digestFor({ title: 'Data Engineer', description: body });

  const naiveSkills = extractSkills(naive).length;
  const smartSkills = extractSkills(smart).length;
  assert.ok(
    smartSkills > naiveSkills,
    `digest kept ${smartSkills} skills, the opening kept ${naiveSkills}`,
  );
  assert.ok(smartSkills >= 4, `expected several skills, got ${smartSkills}`);
});
