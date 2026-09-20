import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// The extension ships plain ES modules with no types of their own; the fields
// used here are asserted below rather than declared.
// @ts-ignore
import { describeField, planFill, matchField, isHoneypot, matchCustom } from '../extension/src/matcher.js';
// @ts-ignore
import { shapeDate } from '../extension/src/fill.js';
// @ts-ignore
import { countryWords } from '../extension/src/answers.js';

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
function load(name: string, dir = 'forms') {
  const html = readFileSync(new URL(`./fixtures/${dir}/${name}.html`, import.meta.url), 'utf8');
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
  assert.match(address.reason, /already (has a value|set to)/);
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
  assert.match(plan.skipped[0]!.reason, /already (has a value|set to)/);
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

test('A QUESTION WITH NO SAVED ANSWER IS LEFT BLANK, NEVER GUESSED', () => {
  // Sponsorship, work authorisation, salary, gender: all answerable, none
  // inferable. With nothing saved, each is reported rather than filled.
  for (const label of [
    'Are you legally authorized to work in Canada?',
    'Will you now or in the future require visa sponsorship?',
    'What are your salary expectations?',
    'What is your gender?',
    'Veteran status',
    'What is your notice period?',
  ]) {
    const dom = new JSDOM(`<label for="q">${label}</label><input id="q">`);
    const d = describeField(dom.window.document.getElementById('q'), { visible: true });
    const plan = planFill([d], PROFILE);
    assert.equal(plan.fills.length, 0, label);
    assert.match(plan.skipped[0]!.reason, /no saved answer/, label);
  }
});

test('a saved answer fills the question it was saved for', () => {
  const saved = {
    ...PROFILE,
    answers: {
      workAuthorised: 'Yes',
      needsSponsorship: 'No',
      salaryExpectation: '140,000 CAD',
      noticePeriod: '4 weeks',
      yearsExperience: '8',
      gender: 'Prefer not to say',
    },
  };
  const cases: [string, string][] = [
    ['Are you legally authorized to work in Canada?', 'Yes'],
    ['Will you now or in the future require visa sponsorship?', 'No'],
    ['What are your salary expectations for this role?', '140,000 CAD'],
    ['What is your notice period?', '4 weeks'],
    ['How many years of experience do you have?', '8'],
    ['What is your gender?', 'Prefer not to say'],
  ];
  for (const [label, expected] of cases) {
    const dom = new JSDOM(`<label for="q">${label}</label><input id="q">`);
    const d = describeField(dom.window.document.getElementById('q'), { visible: true });
    const plan = planFill([d], saved);
    assert.equal(plan.fills.length, 1, label);
    assert.equal(plan.fills[0]!.value, expected, label);
    assert.equal(plan.fills[0]!.why, 'your saved answer');
  }
});

test('SPONSORSHIP AND AUTHORISATION ARE TOLD APART', () => {
  // The two questions sit next to each other on nearly every form and mean
  // opposite things. Getting them the wrong way round would answer "yes, I need
  // sponsorship" for someone who does not.
  const saved = { ...PROFILE, answers: { workAuthorised: 'Yes', needsSponsorship: 'No' } };
  const dom = new JSDOM(`
    <label for="a">Are you legally authorized to work in the United States?</label><input id="a">
    <label for="b">Will you now or in the future require sponsorship for employment visa status?</label><input id="b">`);
  const doc = dom.window.document;
  const fields = ['a', 'b'].map((id) => describeField(doc.getElementById(id), { visible: true }));
  const plan = planFill(fields, saved);
  const byId = new Map(plan.fills.map((f: any) => [f.field.id, f.value]));
  assert.equal(byId.get('a'), 'Yes', 'authorisation');
  assert.equal(byId.get('b'), 'No', 'sponsorship');
});

test('a radio group is answered from one saved yes/no', () => {
  // Ashby asks work authorisation as sentences, not as "Yes"/"No".
  const dom = new JSDOM(`
    <fieldset>
      <legend>Which of the following best describes your right to work in the country where this role is based?</legend>
      <label><input type="radio" name="rtw" value="1"> I am legally authorised to work and will not require employer sponsorship now or in the future</label>
      <label><input type="radio" name="rtw" value="2"> I am not currently legally authorised to work</label>
    </fieldset>`);
  const doc = dom.window.document;
  const fields = [...doc.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
  const plan = planFill(fields, { ...PROFILE, answers: { workAuthorised: 'I am legally authorised' } });
  assert.equal(plan.fills.length, 1);
  assert.equal(plan.fills[0]!.field.el.value, '1');
  assert.equal(plan.fills[0]!.choice, true);
});

test('an answer that matches none of the options is reported, not forced', () => {
  const dom = new JSDOM(`
    <fieldset>
      <legend>What is your notice period?</legend>
      <label><input type="radio" name="n" value="a"> Immediately</label>
      <label><input type="radio" name="n" value="b"> One month</label>
    </fieldset>`);
  const doc = dom.window.document;
  const fields = [...doc.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
  const plan = planFill(fields, { ...PROFILE, answers: { noticePeriod: '12 weeks' } });
  assert.equal(plan.fills.length, 0);
  assert.match(plan.skipped[0]!.reason, /matches none of the options/);
});

test('CONSENT IS NEVER TICKED UNLESS ASKED FOR', () => {
  const dom = new JSDOM('<label for="c">I have read and agree to the privacy policy</label><input id="c" type="checkbox">');
  const d = describeField(dom.window.document.getElementById('c'), { visible: true });
  assert.equal(planFill([d], PROFILE).fills.length, 0);
  assert.equal(matchField(d)?.why, 'consent');

  // And with the option turned on, it is ticked and labelled as such.
  const on = planFill([d], { ...PROFILE, tickConsents: true });
  assert.equal(on.fills.length, 1);
  assert.match(on.fills[0]!.why, /you asked for consents/);
});

test('a cover letter is never written for you', () => {
  for (const label of ['Cover letter', 'Why do you want to work here?', 'Tell us about yourself']) {
    const dom = new JSDOM(`<label for="q">${label}</label><textarea id="q"></textarea>`);
    const d = describeField(dom.window.document.getElementById('q'), { visible: true });
    assert.equal(matchField(d)?.why, 'narrative', label);
    assert.equal(planFill([d], { ...PROFILE, answers: { salaryExpectation: 'x' } }).fills.length, 0, label);
  }
});

test('a password box gets ONLY the saved job-site password, and nothing without one', () => {
  // Workday's create-account page, as captured 19 September 2026.
  const dom = new JSDOM(`
    <label for="e">Email Address*</label><input id="e" type="text" data-automation-id="email" autocomplete="email">
    <label for="p">Password*</label><input id="p" type="password" data-automation-id="password" autocomplete="new-password">
    <label for="v">Verify New Password*</label><input id="v" type="password" data-automation-id="verifyPassword" autocomplete="new-password">`);
  const doc = dom.window.document;
  const fields = ['e', 'p', 'v'].map((id) => describeField(doc.getElementById(id), { visible: true }));
  const none = planFill(fields, PROFILE);
  assert.deepEqual(none.fills.map((f: any) => f.key), ['email']);
  assert.ok(none.skipped.some((s: any) => /nothing in your profile for password/.test(s.reason)));
  const withPassword = planFill(fields, { ...PROFILE, accountPassword: 'Str0ng!Pass' });
  assert.deepEqual(withPassword.fills.map((f: any) => [f.key, f.value]), [
    ['email', 'ada@example.com'],
    ['password', 'Str0ng!Pass'],
    ['passwordConfirm', 'Str0ng!Pass'],
  ]);
});

test('WORKDAY\'S ROBOT TRAP IS LEFT EMPTY — it reads like a website box', () => {
  const dom = new JSDOM('<label for="b">Enter website. This input is for robots only, do not enter if you\'re human.</label><input id="b" data-automation-id="beecatcher">');
  const d = describeField(dom.window.document.getElementById('b'), { visible: true });
  assert.equal(isHoneypot(d), true);
  assert.equal(planFill([d], PROFILE).fills.length, 0);
});

test('an answer the person already typed is never overwritten', () => {
  const dom = new JSDOM('<label for="e">Email</label><input id="e" value="typed@myself.com">');
  const d = describeField(dom.window.document.getElementById('e'), { visible: true });
  const plan = planFill([d], PROFILE);
  assert.equal(plan.fills.length, 0);
  assert.match(plan.skipped[0]!.reason, /already (has a value|set to)/);
});

test('a "confirm email" box gets the same address — SmartRecruiters requires it', () => {
  const dom = new JSDOM(`
    <label for="e1">Email</label><input id="e1">
    <label for="e2">Confirm your email</label><input id="e2">`);
  const doc = dom.window.document;
  const fields = ['e1', 'e2'].map((id) => describeField(doc.getElementById(id), { visible: true }));
  const plan = planFill(fields, PROFILE);
  assert.deepEqual(plan.fills.map((f: any) => [f.field.id, f.key, f.value]), [
    ['e1', 'email', 'ada@example.com'],
    ['e2', 'confirmEmail', 'ada@example.com'],
  ]);
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

// ---------------------------------------------------------------------------
// Your own question/answer pairs
// ---------------------------------------------------------------------------

test('a question no list could predict is answered from your own pair', () => {
  // Real, from a live BambooHR form: "Do you have hands-on experience with MT4
  // and MT5?" Nothing shipped can know that; a pair the person wrote can.
  const profile = {
    ...PROFILE,
    customAnswers: [{ match: 'MT4', answer: 'Yes — six years building MT4/MT5 bridges' }],
  };
  const dom = new JSDOM('<label for="q">Do you have hands-on experience with MT4 and MT5 platforms?</label><input id="q">');
  const d = describeField(dom.window.document.getElementById('q'), { visible: true });
  const plan = planFill([d], profile);
  assert.equal(plan.fills.length, 1);
  assert.equal(plan.fills[0]!.value, 'Yes — six years building MT4/MT5 bridges');
  assert.match(plan.fills[0]!.why, /your answer for "MT4"/);
});

test('THE MOST SPECIFIC PAIR WINS', () => {
  const profile = {
    ...PROFILE,
    customAnswers: [
      { match: 'experience', answer: 'eight years' },
      { match: 'experience with kubernetes', answer: 'three years, in production' },
    ],
  };
  const pick = matchCustom('How many years of experience with Kubernetes do you have?', profile);
  assert.ok(pick);
  assert.equal(pick!.answer, 'three years, in production');
});

test('a pair only fires on a question that contains it', () => {
  const profile = { ...PROFILE, customAnswers: [{ match: 'MT4', answer: 'Yes' }] };
  assert.equal(matchCustom('What is your notice period?', profile), null);
});

test('a half-written pair is ignored rather than filling a blank', () => {
  const profile = { ...PROFILE, customAnswers: [{ match: 'MT4', answer: '' }, { match: '', answer: 'Yes' }] };
  assert.equal(matchCustom('Experience with MT4?', profile), null);
});

test('your own pair answers a radio group too', () => {
  const dom = new JSDOM(`
    <fieldset>
      <legend>This is a fixed term contract role. Is that acceptable to you?</legend>
      <label><input type="radio" name="ft" value="y"> Yes</label>
      <label><input type="radio" name="ft" value="n"> No</label>
    </fieldset>`);
  const doc = dom.window.document;
  const fields = [...doc.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
  const profile = { ...PROFILE, customAnswers: [{ match: 'fixed term contract', answer: 'Yes' }] };
  const plan = planFill(fields, profile);
  assert.equal(plan.fills.length, 1);
  assert.equal(plan.fills[0]!.field.el.value, 'y');
});

test('A COMBINED QUESTION IS NOT ANSWERED BACKWARDS', () => {
  // Live on Greenhouse (Globalization Partners): "Are you currently eligible to
  // work in the country where this role is posted without visa sponsorship?"
  // It contains "sponsorship", so the sponsorship rule claimed it and answered
  // "No" from an answer meaning "I need no sponsorship" — the opposite of true.
  const question = 'Are you currently eligible to work in the country where this role is posted without visa sponsorship?';
  const ask = (answers: Record<string, string>) => {
    const dom = new JSDOM(`<label for="q">${question}</label><input id="q">`);
    const d = describeField(dom.window.document.getElementById('q'), { visible: true });
    return planFill([d], { ...PROFILE, answers });
  };

  assert.equal(ask({ workAuthorised: 'Yes', needsSponsorship: 'No' }).fills[0]!.value, 'Yes');
  assert.equal(ask({ workAuthorised: 'Yes', needsSponsorship: 'Yes' }).fills[0]!.value, 'No');
  assert.equal(ask({ workAuthorised: 'No', needsSponsorship: 'Yes' }).fills[0]!.value, 'No');
  // Neither half known: nothing is guessed.
  const partial = ask({ workAuthorised: 'Yes' });
  assert.equal(partial.fills.length, 0);
  assert.match(partial.skipped[0]!.reason, /no saved answer/);
});

test('the plain sponsorship question still gets the sponsorship answer', () => {
  const dom = new JSDOM('<label for="q">Do you now or in the future require visa sponsorship?</label><input id="q">');
  const d = describeField(dom.window.document.getElementById('q'), { visible: true });
  const plan = planFill([d], { ...PROFILE, answers: { workAuthorised: 'Yes', needsSponsorship: 'No' } });
  assert.equal(plan.fills[0]!.value, 'No');
});

// ---------------------------------------------------------------------------
// Education, experience, files and the rest of a full profile (0.3.0)
// ---------------------------------------------------------------------------

/** One box, described the way the content script describes it. */
function one(html: string, id = 'q') {
  const dom = new JSDOM(html);
  return describeField(dom.window.document.getElementById(id), { visible: true });
}

const FULL = {
  ...PROFILE,
  currentCompany: '',
  currentTitle: '',
  experience: [{ company: 'Northwind Analytics', title: 'Staff Engineer', start: '2021-03', end: '', current: true }],
  education: [{ school: 'University of Waterloo', degree: 'Bachelor of Applied Science', discipline: 'Computer Engineering', start: '2012', end: '2017-04', gpa: '3.7/4.0' }],
  skills: ['Python', 'SQL', 'Airflow'],
};

test('education boxes are filled from the first school on the profile', () => {
  const cases: [string, string, string][] = [
    ['<label for="q">School</label><input id="q">', 'school', 'University of Waterloo'],
    ['<label for="q">University / College</label><input id="q">', 'school', 'University of Waterloo'],
    ['<label for="q">Degree</label><input id="q">', 'degree', 'Bachelor of Applied Science'],
    ['<label for="q">Discipline</label><input id="q">', 'discipline', 'Computer Engineering'],
    ['<label for="q">Field of study</label><input id="q">', 'discipline', 'Computer Engineering'],
    ['<label for="q">GPA</label><input id="q">', 'gpa', '3.7/4.0'],
    ['<label for="q">Graduation year</label><input id="q">', 'graduationYear', '2017'],
  ];
  for (const [html, key, value] of cases) {
    const plan = planFill([one(html)], FULL);
    assert.equal(plan.fills[0]?.key, key, html);
    assert.equal(plan.fills[0]?.value, value, html);
  }
});

test('"highest level of education" is the saved answer, not the school box', () => {
  const d = one('<label for="q">What is your highest level of education?</label><input id="q">');
  const plan = planFill([d], { ...FULL, answers: { education: "Master's degree" } });
  assert.equal(plan.fills[0]?.key, 'education');
});

test('current company and title fall back to the first job', () => {
  const plan = planFill([one('<label for="q">Current company</label><input id="q">')], FULL);
  assert.equal(plan.fills[0]?.value, 'Northwind Analytics');
  const title = planFill([one('<label for="q">Current title</label><input id="q">')], FULL);
  assert.equal(title.fills[0]?.value, 'Staff Engineer');
});

test('WORKDAY names its fields section_field, and the field part is read', () => {
  const html = `
    <input id="a" data-automation-id="legalNameSection_firstName">
    <input id="b" data-automation-id="legalNameSection_lastName">
    <input id="c" data-automation-id="addressSection_city">
    <input id="d" data-automation-id="email">`;
  const dom = new JSDOM(html);
  const fields = ['a', 'b', 'c', 'd'].map((id) => describeField(dom.window.document.getElementById(id), { visible: true }));
  const plan = planFill(fields, FULL);
  assert.deepEqual(plan.fills.map((f: any) => f.key), ['firstName', 'lastName', 'city', 'email']);
});

test('a cover-letter FILE box gets the saved cover letter, never the résumé', () => {
  const html = `
    <label for="r">Resume/CV</label><input id="r" type="file">
    <label for="c">Cover Letter</label><input id="c" type="file">`;
  const dom = new JSDOM(html);
  const [r, c] = ['r', 'c'].map((id) => describeField(dom.window.document.getElementById(id), { visible: true }));
  const without = planFill([r, c], FULL);
  assert.deepEqual(without.fills.map((f: any) => f.key), ['resume']);
  assert.match(without.skipped[0]!.reason, /nothing in your profile for coverLetter/);
  const withLetter = planFill([r, c], { ...FULL, coverLetter: { name: 'letter.pdf' } });
  assert.deepEqual(withLetter.fills.map((f: any) => [f.key, f.value]), [['resume', 'ada-lovelace.pdf'], ['coverLetter', 'letter.pdf']]);
});

test('a cover-letter TEXT box is filled only with a letter the person wrote and saved', () => {
  const d = one('<label for="q">Cover letter</label><textarea id="q"></textarea>');
  assert.equal(planFill([d], FULL).fills.length, 0);
  const plan = planFill([d], { ...FULL, coverLetterText: 'Dear team, …' });
  assert.equal(plan.fills[0]?.key, 'coverLetterText');
  assert.equal(plan.fills[0]?.why, 'your saved cover letter');
  // "Why do you want to work here?" is still never answered, letter or not.
  const why = one('<label for="q">Why do you want to work here?</label><textarea id="q"></textarea>');
  assert.equal(planFill([why], { ...FULL, coverLetterText: 'Dear team, …' }).fills.length, 0);
});

test('a skills box is filled, a skills PICKER is not', () => {
  const box = planFill([one('<label for="q">Skills</label><textarea id="q"></textarea>')], FULL);
  assert.equal(box.fills[0]?.value, 'Python, SQL, Airflow');
  const picker = planFill([one('<label for="q">Skills</label><input id="q" role="combobox">')], FULL);
  assert.equal(picker.fills.length, 0);
});

test('new question types are answered from saved answers', () => {
  const answers = {
    hispanicLatino: 'No', ethnicity: 'Asian', driversLicense: 'Yes', securityClearance: 'None',
    willingToTravel: 'Up to 25%', appliedBefore: 'No', currentlyEmployed: 'Yes', timezone: 'EST',
  };
  const cases: [string, string][] = [
    ['Are you Hispanic/Latino?', 'hispanicLatino'],
    ['Race', 'ethnicity'],
    ['Do you have a valid driver’s license?', 'driversLicense'],
    ['Do you hold an active security clearance?', 'securityClearance'],
    ['Are you willing to travel?', 'willingToTravel'],
    ['Have you previously applied to Acme?', 'appliedBefore'],
    ['Are you currently employed?', 'currentlyEmployed'],
    ['What time zone are you based in?', 'timezone'],
  ];
  for (const [label, key] of cases) {
    const plan = planFill([one(`<label for="q">${label}</label><input id="q">`)], { ...FULL, answers });
    assert.equal(plan.fills[0]?.key, key, label);
  }
});

test('ASHBY DIVERSITY QUESTIONS: tick boxes grouped by question, "rather not say" found', () => {
  // Captured live 18 September 2026. Ashby names each tick box after its
  // OPTION ("White", "Veteran"), labels the question with a <label> rather than
  // a legend, and words the decline option "I prefer not to answer". Before the
  // fix every tick box was a one-option "question", "Person with disability"
  // was taken for a question, and a saved "Prefer not to say" matched nothing.
  const { fields } = load('ashby-eeo', 'fragments');
  const plan = planFill(fields, { answers: { gender: 'Prefer not to say', ethnicity: 'Prefer not to say', howDidYouHear: 'LinkedIn' } });
  const filled = plan.fills.map((f: any) => [f.key, f.field.label]);
  assert.deepEqual(filled, [
    ['gender', 'I prefer not to answer'],
    ['ethnicity', 'I prefer not to answer'],
    ['howDidYouHear', 'LinkedIn'],
  ]);
  // Nothing is reported as "already has a value" — an unticked box is empty.
  assert.equal(plan.skipped.some((s: any) => /already/.test(s.reason)), false);
  // Left blank, the voluntary ones stay blank.
  const none = planFill(fields, { answers: {} });
  assert.equal(none.fills.length, 0);
});

test('a lone tick box is never typed into', () => {
  const d = one('<label for="q">Veteran</label><input id="q" type="checkbox">');
  const plan = planFill([d], { ...FULL, answers: { veteranStatus: 'I am not a protected veteran' } });
  assert.equal(plan.fills.length, 0);
});

test('a skipped question says which saved answer it wanted, for "remember what I typed"', () => {
  const plan = planFill([one('<label for="q">What is your notice period?</label><input id="q">')], FULL);
  assert.equal(plan.skipped[0]!.answerKey, 'noticePeriod');
  const html = `<fieldset><legend>Do you have a valid driving licence?</legend>
    <label><input type="radio" name="dl" value="1"> Yes</label><label><input type="radio" name="dl" value="0"> No</label></fieldset>`;
  const dom = new JSDOM(html);
  const radios = [...dom.window.document.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
  const group = planFill(radios, FULL);
  assert.equal(group.skipped[0]!.answerKey, 'driversLicense');
  assert.equal(group.skipped[0]!.members.length, 2);
});

// ---------------------------------------------------------------------------
// Vendor fixes, 19 September 2026 — each from a live form
// ---------------------------------------------------------------------------

test('RIPPLING: a menu drawn as <div role="combobox"> is a field, and gets its answer', () => {
  // Gender, Hispanic/Latino, Veteran Status and Disability Status on Rippling
  // are divs, not inputs, and were invisible to the extension.
  const dom = new JSDOM(`
    <span id="l1">Veteran Status</span><div id="v" role="combobox" aria-labelledby="l1" tabindex="0"><p>Select...</p></div>
    <span id="l2">Are you Hispanic/Latino?</span><div id="h" role="combobox" aria-labelledby="l2" tabindex="0"><p>Select...</p></div>`);
  const doc = dom.window.document;
  const fields = ['v', 'h'].map((id) => describeField(doc.getElementById(id), { visible: true }));
  assert.equal(fields[0]!.type, 'combobox');
  assert.equal(fields[0]!.hasValue, false, '"Select..." is not an answer');
  const plan = planFill(fields, { ...PROFILE, answers: { veteranStatus: 'I am not a protected veteran', hispanicLatino: 'No' } });
  assert.deepEqual(plan.fills.map((f: any) => f.key), ['veteranStatus', 'hispanicLatino']);
});

test('TEAMTAILOR: "Phone number with country code" is the phone number', () => {
  const dom = new JSDOM('<label for="p">Phone</label><input id="p" type="tel" name="candidate[phone]" autocomplete="tel"><p>Phone number with country code</p>');
  const d = describeField(dom.window.document.getElementById('p'), { visible: true });
  d.label = 'Phone*Required | Phone number with country code';
  assert.equal(matchField(d)?.key, 'phone');
});

test('ORACLE: the phone code picker is told apart from the phone number', () => {
  const dom = new JSDOM(`
    <label for="c">Country code</label><input id="country-codes-dropdownphoneNum" role="combobox" value="+39">
    <label for="n">Phone Number</label><input id="n" type="tel">`);
  const doc = dom.window.document;
  const code = describeField(doc.getElementById('country-codes-dropdownphoneNum'), { visible: true });
  const number = describeField(doc.getElementById('n'), { visible: true });
  assert.equal(matchField(code)?.key, 'phoneCountry');
  assert.equal(matchField(number)?.key, 'phone');
  const plan = planFill([code, number], { ...PROFILE, country: 'India' });
  assert.deepEqual(plan.fills.map((f: any) => [f.key, f.value]), [['phoneCountry', 'India'], ['phone', PROFILE.phone]]);
});

test('ORACLE: a country the SITE chose is replaced, and the panel says so', () => {
  // Oracle opens its form with Country = the employer's own ("Italy").
  const dom = new JSDOM('<label for="c">Country *</label><input id="c" name="country" role="combobox" value="Italy">');
  const d = describeField(dom.window.document.getElementById('c'), { visible: true });
  const plan = planFill([d], { ...PROFILE, country: 'India' });
  assert.equal(plan.fills[0]?.value, 'India');
  assert.match(plan.fills[0]!.why, /replaced the site's "Italy"/);
  // Already the right country — in any of its names — is left alone.
  const us = new JSDOM('<label for="c">Country</label><input id="c" name="country" value="United States of America">');
  const same = planFill([describeField(us.window.document.getElementById('c'), { visible: true })], { ...PROFILE, country: 'United States' });
  assert.equal(same.fills.length, 0);
  assert.equal(same.skipped[0]!.reason, 'set to your country');
});

test('TEAMTAILOR: a place-search address box is given the WHOLE address to search', () => {
  const dom = new JSDOM('<label for="a">Address</label><input id="a" name="candidate[location][query]" autocomplete="street-address" role="combobox" placeholder="Start typing your address">');
  const d = describeField(dom.window.document.getElementById('a'), { visible: true });
  const plan = planFill([d], PROFILE);
  assert.equal(plan.fills[0]?.key, 'address');
  assert.equal(plan.fills[0]?.lookup, true);
  assert.equal(plan.fills[0]?.value, '1 Example Street, Toronto, Ontario, M5V 2T6, Canada');
  assert.equal(plan.fills[0]?.fallback, '1 Example Street, Toronto');
});

test('BREEZY: unlabelled date boxes are read by their ng-model, never as "Company"', () => {
  // The education block's date inputs carry placeholder="Company" (a vendor
  // slip) and are named only by ng-model.
  const dom = new JSDOM(`
    <input id="s" placeholder="School" ng-model="candidateSchool.school_name">
    <input id="a" type="date" placeholder="Company" ng-model="candidateSchool.date_start">
    <input id="b" type="date" placeholder="Company" ng-model="candidateSchool.date_end">
    <input id="c" placeholder="Company" ng-model="candidatePosition.company_name">
    <input id="d" type="date" placeholder="Company" ng-model="candidatePosition.date_start">`);
  const doc = dom.window.document;
  const f = (id: string) => describeField(doc.getElementById(id), { visible: true });
  assert.equal(matchField(f('s'))?.key, 'school');
  assert.equal(matchField(f('a'))?.key, 'eduStart');
  assert.equal(matchField(f('b'))?.key, 'eduEnd');
  assert.equal(matchField(f('c'))?.key, 'currentCompany');
  assert.equal(matchField(f('d'))?.key, 'jobStart');
  const plan = planFill(['a', 'b'].map(f), { education: [{ school: 'U', start: '2012-09', end: '2017-04' }] });
  assert.deepEqual(plan.fills.map((x: any) => [x.key, x.value]), [['eduStart', '2012-09'], ['eduEnd', '2017-04']]);
});

test('BREEZY: a question titled by a heading, with no label, is read', () => {
  const dom = new JSDOM(`<div class="dropdown"><h3><span>What Nationality / Nationalities do you hold?</span></h3>
    <div class="dropdown-container"><div class="select-wrapper"><select id="q" name="section_1_question_0"><option></option><option>Canadian</option></select></div></div></div>`);
  const d = describeField(dom.window.document.getElementById('q'), { visible: true });
  assert.match(d.label, /Nationality/);
  const plan = planFill([d], { ...PROFILE, answers: { nationality: 'Canadian' } });
  assert.equal(plan.fills[0]?.key, 'nationality');
});

test('SMARTRECRUITERS: a field inside a shadow root is labelled from inside it', () => {
  const dom = new JSDOM('<spl-input id="host" label="First name"></spl-input>');
  const host = dom.window.document.getElementById('host')!;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<label for="first-name-input">First name*</label><input id="first-name-input" autocomplete="given-name">';
  const d = describeField(root.getElementById('first-name-input'), { visible: true });
  assert.match(d.label, /First name/);
  assert.equal(matchField(d)?.key, 'firstName');
});

test('dates go in the shape each box wants, and a year is never made into a date', () => {
  const dom = new JSDOM(`<input id="d" type="date"><input id="m" placeholder="MM/YYYY"><input id="y"><input id="t">`);
  const doc = dom.window.document;
  const el = (id: string) => doc.getElementById(id);
  assert.equal(shapeDate(el('d'), '2021-03').value, '2021-03-01');
  assert.match(String(shapeDate(el('d'), '2021').error), /only "2021"/);
  assert.equal(shapeDate(el('m'), '2021-03').value, '03/2021');
  assert.equal(shapeDate(el('y'), '2021-03', 'Start year').value, '2021');
  assert.equal(shapeDate(el('t'), '2021-03', 'Start month').value, 'March');
});

test('countries are known by all their names and their dialling code', () => {
  assert.deepEqual(countryWords('USA').slice(0, 3), ['united states', 'united states of america', 'usa']);
  assert.ok(countryWords('India').includes('+91'));
  assert.deepEqual(countryWords('Narnia'), []);
});

test('ASHBY: "Type here..." never makes a referral-name box a "worked here before?" question', () => {
  const dom = new JSDOM('<label for="a">If referred by an IRIS employee, please share their name.</label><input id="a" placeholder="Type here...">');
  const d = describeField(dom.window.document.getElementById('a'), { visible: true });
  const plan = planFill([d], { ...PROFILE, answers: { workedHereBefore: 'No', wasReferred: 'No', referredBy: '' } });
  assert.equal(plan.fills.length, 0, 'a yes/no answer went into a name box');
  assert.match(plan.skipped[0]!.reason, /Who referred you/);
});

test('WORKABLE: the menu beside the phone number is its dialling-code picker', () => {
  const dom = new JSDOM('<label for="c">Phone</label><select id="c" name="phone_country"><option>United States+1</option><option>Canada+1</option></select>');
  const d = describeField(dom.window.document.getElementById('c'), { visible: true });
  assert.equal(matchField(d)?.key, 'phoneCountry');
});
