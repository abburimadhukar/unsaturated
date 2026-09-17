import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// The extension ships plain ES modules with no types of their own; the fields
// used here are asserted below rather than declared.
// @ts-ignore
import { describeField, planFill, matchField, isHoneypot } from '../extension/src/matcher.js';

/**
 * The matcher, against forms that really exist.
 *
 * Every fixture in tests/fixtures/forms is the DOM of a live application form,
 * captured with Chrome on 17 September 2026 by scripts/ats-survey.mjs and
 * stripped of scripts and images. They are the whole point of this file: a
 * matcher tested against forms invented by the person writing it will pass
 * forever and fill nothing, because the hard part is not the logic — it is that
 * seven vendors name the same box seven different ways.
 *
 * Fixtures are frozen copies. When a vendor redesigns, the live check
 * (scripts/fill-live.mjs) is what notices; these keep the logic honest meanwhile.
 */

const PROFILE = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  preferredName: 'Ada',
  email: 'ada@example.com',
  phone: '+1 415 555 0142',
  city: 'Toronto',
  region: 'Ontario',
  country: 'Canada',
  postcode: 'M5V 2T6',
  address: '1 Example Street',
  linkedin: 'https://www.linkedin.com/in/example',
  github: 'https://github.com/example',
  website: 'https://example.com',
  currentCompany: 'Analytical Engines',
  currentTitle: 'Senior Data Engineer',
  resume: { name: 'ada-lovelace.pdf' },
};

/** jsdom has no layout, so everything is treated as visible unless hidden. */
function load(name: string) {
  const html = readFileSync(new URL(`./fixtures/forms/${name}.html`, import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  // The matcher reads `el.closest`, `CSS.escape` and friends off the document's
  // own window, which jsdom provides; only visibility has to be faked.
  const fields = [...doc.querySelectorAll('input, textarea, select')]
    .filter((el: any) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type))
    .map((el: any) => describeField(el, { visible: el.getAttribute('aria-hidden') !== 'true' }));
  return { doc, fields };
}

const keysFilled = (name: string) => {
  const { fields } = load(name);
  const plan = planFill(fields, PROFILE);
  return new Map(plan.fills.map((f: any) => [f.key, f.value]));
};

// ---------------------------------------------------------------------------
// Every vendor, the same seven facts
// ---------------------------------------------------------------------------

test('greenhouse: split name, email, phone and the hidden résumé input', () => {
  const filled = keysFilled('greenhouse');
  assert.equal(filled.get('firstName'), 'Ada');
  assert.equal(filled.get('lastName'), 'Lovelace');
  assert.equal(filled.get('preferredName'), 'Ada');
  assert.equal(filled.get('email'), 'ada@example.com');
  assert.equal(filled.get('phone'), '+1 415 555 0142');
  assert.equal(filled.get('resume'), 'ada-lovelace.pdf');
  // "Full Name" must not appear: this form has First and Last.
  assert.equal(filled.has('fullName'), false);
});

test('lever: ONE full-name box, and links named urls[LinkedIn]', () => {
  // Lever asks for "Full name" in a single field named `name`, and puts the
  // links in `urls[LinkedIn]` / `urls[GitHub]` — names no other vendor uses.
  const filled = keysFilled('lever');
  assert.equal(filled.get('fullName'), 'Ada Lovelace');
  assert.equal(filled.get('email'), 'ada@example.com');
  assert.equal(filled.get('linkedin'), PROFILE.linkedin);
  assert.equal(filled.get('github'), PROFILE.github);
  assert.equal(filled.get('currentCompany'), 'Analytical Engines');
});

test('ashby: system fields by name, custom questions by UUID and label', () => {
  const filled = keysFilled('ashby');
  assert.equal(filled.get('fullName'), 'Ada Lovelace');
  assert.equal(filled.get('email'), 'ada@example.com');
  assert.equal(filled.get('phone'), '+1 415 555 0142');
  // The LinkedIn box is <input id="b4d59f24-…"> — only its label identifies it.
  assert.equal(filled.get('linkedin'), PROFILE.linkedin);
});

test('workable: first/last plus a split postal address', () => {
  const filled = keysFilled('workable');
  assert.equal(filled.get('firstName'), 'Ada');
  assert.equal(filled.get('lastName'), 'Lovelace');
  assert.equal(filled.get('email'), 'ada@example.com');
  // Workable had already guessed an address from the crawler's IP —
  // "Redmond, United States of America" — so the box is NOT overwritten. It is
  // surfaced for the person instead, which is the whole point of the rule.
  const { fields } = load('workable');
  const address = planFill(fields, PROFILE).skipped.find((s: any) => s.field.id === 'address');
  assert.ok(address, 'the prefilled address should be reported, not ignored');
  assert.match(address.reason, /already has a value/);
});

test('A DIAL CODE THE SITE TYPED IS REPLACED — it is not an answer', () => {
  // Recruitee's phone box arrives holding "+55".
  const filled = keysFilled('recruitee');
  assert.equal(filled.get('phone'), '+1 415 555 0142');
});

test('a value the person typed is never replaced', () => {
  const dom = new JSDOM('<label for="p">Phone</label><input id="p" value="+1 604 555 0000">');
  const d = describeField(dom.window.document.getElementById('p'), { visible: true });
  const plan = planFill([d], PROFILE);
  assert.equal(plan.fills.length, 0);
  assert.match(plan.skipped[0]!.reason, /already has a value/);
});

test('recruitee: dotted names like candidate.phone', () => {
  const filled = keysFilled('recruitee');
  assert.equal(filled.get('fullName'), 'Ada Lovelace');
  assert.equal(filled.get('email'), 'ada@example.com');
});

test('RIPPLING — THE CASE LABELS MUST CARRY ALONE', () => {
  // ids are positional (`field-35`) and names are random tokens
  // (`FlKLEygNhmU`). If label matching ever regresses, this form fills nothing.
  const filled = keysFilled('rippling');
  assert.equal(filled.get('firstName'), 'Ada');
  assert.equal(filled.get('lastName'), 'Lovelace');
  assert.equal(filled.get('email'), 'ada@example.com');
  assert.equal(filled.get('phone'), '+1 415 555 0142');
  assert.equal(filled.get('linkedin'), PROFILE.linkedin);
});

test('bamboohr: FabricTextField ids, identified by label alone', () => {
  const filled = keysFilled('bamboohr');
  assert.equal(filled.get('firstName'), 'Ada');
  assert.equal(filled.get('lastName'), 'Lovelace');
  assert.equal(filled.get('address'), '1 Example Street');
  assert.equal(filled.get('city'), 'Toronto');
  assert.equal(filled.get('linkedin'), PROFILE.linkedin);
});

// ---------------------------------------------------------------------------
// What must never be filled
// ---------------------------------------------------------------------------

test('THE BAMBOOHR HONEYPOT IS LEFT EMPTY', () => {
  // <input id="nickname_hpcsaf"> labelled "Please leave this field blank".
  // Filling it is how an application gets marked as a bot.
  const { fields } = load('bamboohr');
  const trap = fields.find((f: any) => /hpcsaf/.test(f.id));
  assert.ok(trap, 'the honeypot is gone from the fixture — check the capture');
  assert.equal(isHoneypot(trap), true);
  const plan = planFill(fields, PROFILE);
  assert.equal(plan.fills.some((f: any) => /hpcsaf/.test(f.field.id)), false);
});

test('demographic questions are refused, by kind', () => {
  for (const label of [
    'What is your gender?',
    'Are you Hispanic/Latino?',
    'Veteran status',
    'Disability status',
    'What are your pronouns?',
  ]) {
    const dom = new JSDOM(`<label for="q">${label}</label><input id="q">`);
    const el = dom.window.document.getElementById('q');
    const d = describeField(el, { visible: true });
    assert.deepEqual(matchField(d), { key: null, why: 'sensitive' }, label);
  }
});

test('legal attestations are refused — a wrong one is a lie in your name', () => {
  for (const label of [
    'Are you legally authorized to work in Canada?',
    'Will you now or in the future require visa sponsorship?',
    'Do you have the right to work in the UK?',
    'Have you ever been convicted of a felony?',
  ]) {
    const dom = new JSDOM(`<label for="q">${label}</label><input id="q">`);
    const d = describeField(dom.window.document.getElementById('q'), { visible: true });
    assert.equal(matchField(d)?.key, null, label);
    assert.equal(matchField(d)?.why, 'attestation', label);
  }
});

test('salary and consent are the person’s own, always', () => {
  const cases: [string, string][] = [
    ['What is your target salary range?', 'money'],
    ['Desired Pay', 'money'],
    ['I agree to the privacy policy', 'consent'],
    ['Why do you want to work here?', 'narrative'],
    ['Cover letter', 'narrative'],
  ];
  for (const [label, why] of cases) {
    const dom = new JSDOM(`<label for="q">${label}</label><input id="q">`);
    const d = describeField(dom.window.document.getElementById('q'), { visible: true });
    assert.equal(matchField(d)?.why, why, label);
  }
});

test('a password box is never touched', () => {
  const dom = new JSDOM('<label for="p">Password</label><input id="p" type="password">');
  const d = describeField(dom.window.document.getElementById('p'), { visible: true });
  assert.equal(matchField(d), null);
});

test('an answer the person already typed is never overwritten', () => {
  const dom = new JSDOM('<label for="e">Email</label><input id="e" value="typed@myself.com">');
  const d = describeField(dom.window.document.getElementById('e'), { visible: true });
  const plan = planFill([d], PROFILE);
  assert.equal(plan.fills.length, 0);
  assert.match(plan.skipped[0]!.reason, /already has a value/);
});

test('a second email box (confirmation) is not filled twice', () => {
  const dom = new JSDOM(`
    <label for="e1">Email</label><input id="e1">
    <label for="e2">Confirm email</label><input id="e2">`);
  const doc = dom.window.document;
  const fields = ['e1', 'e2'].map((id) => describeField(doc.getElementById(id), { visible: true }));
  const plan = planFill(fields, PROFILE);
  assert.equal(plan.fills.length, 1);
  assert.equal(plan.fills[0]!.field.id, 'e1');
});

test('nothing is filled when the profile is empty', () => {
  const { fields } = load('greenhouse');
  assert.equal(planFill(fields, {}).fills.length, 0);
});

// ---------------------------------------------------------------------------
// Coverage across every fixture at once
// ---------------------------------------------------------------------------

test('every captured form fills the four basics', () => {
  const names = readdirSync(new URL('./fixtures/forms/', import.meta.url)).map((f) => f.replace('.html', ''));
  assert.ok(names.length >= 7, `expected the captured forms, found ${names.length}`);
  for (const name of names) {
    const filled = keysFilled(name);
    const hasName = filled.has('fullName') || (filled.has('firstName') && filled.has('lastName'));
    assert.ok(hasName, `${name}: no name field matched`);
    assert.ok(filled.has('email'), `${name}: no email field matched`);
  }
});
