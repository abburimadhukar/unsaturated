import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// @ts-ignore — plain ES modules shipped with the extension
import { describeField, planFill, matchField, isHoneypot } from '../extension/src/matcher.js';
// @ts-ignore
import { shapeFor, parseDay, valueLanded } from '../extension/src/fill.js';
// @ts-ignore
import { pickOption, bandFor, degreeWords } from '../extension/src/answers.js';

/**
 * The gaps found on 19 September 2026 by auditing live forms end to end
 * (scripts/audit-ext.mjs) with a profile in which EVERY detail and answer was
 * filled — so a box left empty was the extension's fault, not the profile's.
 * Each test is one of those forms, cut down to the markup that mattered.
 */

const PROFILE = {
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+1 415 555 0142',
  city: 'Toronto', region: 'Ontario', country: 'Canada', postcode: 'M5V 2T6', address: '1 Example Street',
};

const fieldsOf = (dom: JSDOM) => [...dom.window.document.querySelectorAll('input, select, textarea, [role="combobox"]')]
  .filter((el: any) => !(el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA' && el.querySelector('input, select, textarea')))
  .map((el: any) => describeField(el, { visible: true }));

test('BAMBOOHR: separate declarations are never grouped, and never ticked', () => {
  const dom = new JSDOM(`<div><label>Are you 18 years or older? *</label>
    <div><label><input type="radio" name="q18" value="yes">Yes</label><label><input type="radio" name="q18" value="no">No</label></div>
    <div data-fabric-component="Checkbox"><label><span><input id="c1" name="c1" type="checkbox"></span><span><div>I completed this application myself. All statements in it are truthful.</div></span></label></div>
    <div data-fabric-component="Checkbox"><label><span><input id="c2" name="c2" type="checkbox"></span><span><div>I authorize PEMCCO to contact employers and references I have provided.</div></span></label></div>
    <input id="t" name="special" type="text"></div>`);
  const plan = planFill(fieldsOf(dom), { ...PROFILE, answers: { over18: 'Yes' } });
  assert.equal(plan.fills.filter((f: any) => f.field.type === 'checkbox').length, 0, 'a declaration was ticked in the person’s name');
});

test('RIPPLING: a menu labelled only "Select" is read from the question written above it', () => {
  const dom = new JSDOM(`<div><div><div><p>Are you legally authorized to work in the country where this position is located?</p></div></div>
    <div data-testid="field"><div><div data-testid="select-controller"><div><div id="m" role="combobox" aria-label="Select" aria-required="true"><p>Select</p></div></div></div></div></div>`);
  const d = describeField(dom.window.document.getElementById('m'), { visible: true });
  assert.match(d.label, /legally authorized/);
  const plan = planFill([d], { ...PROFILE, answers: { workAuthorised: 'Yes' } });
  assert.equal(plan.fills[0]?.key, 'workAuthorised');
});

test('RIPPLING: round buttons whose question is a <p> beside the group are answered', () => {
  const dom = new JSDOM(`<div><div><div><p>Will you require relocation assistance?</p></div></div>
    <div data-testid="field"><div role="radiogroup">
      <div role="radio"><input type="radio" name="r" value="Yes" aria-labelledby="l1"><div id="l1"><p>Yes</p></div></div>
      <div role="radio"><input type="radio" name="r" value="No" aria-labelledby="l2"><div id="l2"><p>No</p></div></div>
    </div></div></div>`);
  const fields = [...dom.window.document.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
  const plan = planFill(fields, { ...PROFILE, answers: { relocationAssistance: 'No', willingToRelocate: 'Yes' } });
  assert.equal(plan.fills.length, 1);
  assert.equal(plan.fills[0].key, 'relocationAssistance');
  assert.equal(plan.fills[0].field.el.value, 'No');
});

test('ASHBY: yes/no asked as two buttons is answered by pressing the right one', () => {
  const dom = new JSDOM(`<div data-field-path="u1"><label for="u1">Are you legally authorized to work in the United States?</label>
    <div><button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button><input type="checkbox" tabindex="-1" name="u1"></div></div>
    <div data-field-path="u2"><label for="u2">Will you now, or in the future, require visa sponsorship?</label>
    <div><button aria-pressed="false">Yes</button><button aria-pressed="false">No</button><input type="checkbox" tabindex="-1" name="u2"></div></div>`);
  const fields = [...dom.window.document.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
  const plan = planFill(fields, { ...PROFILE, answers: { workAuthorised: 'Yes', needsSponsorship: 'No' } });
  assert.deepEqual(plan.fills.map((f: any) => [f.key, f.button.textContent]), [['workAuthorised', 'Yes'], ['needsSponsorship', 'No']]);
});

test('ASHBY: "select all that apply" ticks every saved answer, and "Female" is "Woman"', () => {
  const opts = (group: string, labels: string[], radio = false) => labels
    .map((l, i) => `<div><input type="${radio ? 'radio' : 'checkbox'}" id="${group}${i}" name="${radio ? group : l}"><label for="${group}${i}">${l}</label></div>`).join('');
  const dom = new JSDOM(`<fieldset><label>What is your gender identity?</label>${opts('g', ['Man', 'Woman', 'Non-Binary', 'I prefer not to answer'], true)}</fieldset>
    <fieldset><label>Which ethnicity(ies) do you identify with? Please select all that apply.</label>${opts('e', ['Asian', 'Black', 'White', 'I prefer not to answer'])}</fieldset>
    <fieldset><label>Which of the following communities do you belong to? Please select all that apply.</label>${opts('c', ['Person with disability', 'Neurodiverse', 'Veteran', 'None of the above'])}</fieldset>`);
  const fields = [...dom.window.document.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
  const plan = planFill(fields, { ...PROFILE, answers: { gender: 'Female', ethnicity: 'White, Asian', communities: 'None of the above' } });
  const picked = plan.fills.map((f: any) => `${f.key}:${f.field.label}`).sort();
  assert.deepEqual(picked, ['communities:None of the above', 'ethnicity:Asian', 'ethnicity:White', 'gender:Woman']);
});

test('options are matched by meaning, by whole words, and never by one letter', () => {
  assert.equal(pickOption(['Man', 'Woman', 'Non-Binary'], 'Female'), 1);
  assert.equal(pickOption(['Yes, I have a disability (or previously had a disability)', "No, I don't have a disability and have not had one in the past", 'I do not want to answer'], 'No, I do not have a disability'), 1);
  assert.equal(pickOption(['Decline to Answer', 'Not a Veteran', 'Veteran'], 'I am not a protected veteran'), 1);
  assert.equal(pickOption(['I completed this application myself. All statements in it are truthful'], 'Yes'), -1);
  assert.equal(pickOption(['Yes', 'No'], 'None'), 1, 'a clearance of "None" answers "do you hold one?" with No');
});

test('a salary goes in its band, and a salary on the edge of two bands is left for the person', () => {
  const bands = ['$90,000 - $100,000', '$100,000 - $110,000', '$110,000 - $120,000', '$120,000+'];
  assert.equal(bandFor(bands, '105000'), 1);
  assert.equal(bandFor(bands, '$135k'), 3);
  assert.equal(bandFor(bands, '120000'), -1);
  assert.equal(bandFor(bands, '120000 CAD, negotiable'), -1, 'only a plain number is read');
});

test('a BSc finds "Bachelor of Science" before any "Bachelor of Arts"', () => {
  assert.equal(degreeWords('BSc Computer Science')[0], 'bachelor of science');
  assert.ok(!degreeWords('Bachelor of Science').includes('bachelor of arts (b.a.)'));
  assert.equal(degreeWords('MA History')[0], 'master of arts');
});

test('the state is recognised when asked as a question, not when asked yes/no', () => {
  const dom = new JSDOM(`<label for="a">In which state do you permanently reside?</label><input id="a" role="combobox" placeholder="Start typing...">
    <label for="b">Do you reside in the state of California?</label><input id="b">`);
  const f = (id: string) => describeField(dom.window.document.getElementById(id), { visible: true });
  assert.equal(matchField(f('a'))?.key, 'region');
  assert.notEqual(matchField(f('b'))?.key, 'region');
});

test('"10+ years of experience?" is worked out from the saved years — but not for one tool', () => {
  const ask = (q: string) => {
    const dom = new JSDOM(`<fieldset><legend>${q}</legend><label><input type="radio" name="x" value="y">Yes</label><label><input type="radio" name="x" value="n">No</label></fieldset>`);
    const fields = [...dom.window.document.querySelectorAll('input')].map((el: any) => describeField(el, { visible: true }));
    return planFill(fields, { ...PROFILE, answers: { yearsExperience: '7' } });
  };
  assert.equal(ask('Do you have 5+ years of professional experience?').fills[0]?.field.el.value, 'y');
  assert.equal(ask('Do you have 10+ years experience?').fills[0]?.field.el.value, 'n');
  assert.equal(ask('Do you have 5+ years of experience in Salesforce?').fills.length, 0);
});

test('BAMBOOHR: a hidden <select> behind its menu button is a field, not a trap', () => {
  const dom = new JSDOM(`<div data-fabric-component="SelectField InputWrapper"><label for="s">State *</label>
    <div data-fabric-component="Select"><button aria-haspopup="true" data-menu-id="m1"><div>–Select–</div></button>
    <select id="s" name="state.value" aria-hidden="true" tabindex="-1"><option value=""></option></select></div></div>`);
  const d = describeField(dom.window.document.getElementById('s'), { visible: true });
  assert.equal(isHoneypot(d), false);
  assert.equal(matchField(d)?.key, 'region');
  assert.equal(d.hasValue, false, '"–Select–" on the button is no answer');
});

test('FULL DETAILS: date of birth, a "Title" menu, suffix, address line 2 and county', () => {
  const dom = new JSDOM(`<label for="dob">Date of Birth</label><input id="dob" type="date">
    <label for="yob">Year of birth</label><input id="yob">
    <label for="sal">Title</label><select id="sal"><option></option><option>Mr.</option><option>Ms.</option><option>Dr.</option></select>
    <label for="job">Title</label><input id="job">
    <label for="suf">Suffix</label><input id="suf">
    <label for="a2">Address Line 2</label><input id="a2">
    <label for="cty">County</label><input id="cty">`);
  const f = (id: string) => describeField(dom.window.document.getElementById(id), { visible: true });
  assert.equal(matchField(f('dob'))?.key, 'dateOfBirth');
  assert.notEqual(matchField(f('yob'))?.key, 'dateOfBirth');
  assert.equal(matchField(f('sal'))?.key, 'salutation');
  assert.equal(matchField(f('job'))?.key, 'currentTitle');
  assert.equal(matchField(f('suf'))?.key, 'nameSuffix');
  assert.equal(matchField(f('a2'))?.key, 'address2');
  assert.equal(matchField(f('cty'))?.key, 'county');
  const plan = planFill([f('dob')], { ...PROFILE, answers: { yearOfBirth: '1990' } });
  assert.equal(plan.fills.length, 0, 'a year of birth was turned into a date of birth');
  const full = planFill([f('dob')], { ...PROFILE, dateOfBirth: '1990-04-12' });
  assert.equal(full.fills[0]?.value, '1990-04-12');
});

test('a text box that names its date shape gets that shape, and no day is ever invented', () => {
  const dom = new JSDOM(`<input id="us" placeholder="mm/dd/yyyy"><input id="eu" placeholder="DD.MM.YYYY"><input id="d" type="date">`);
  const el = (id: string) => dom.window.document.getElementById(id);
  assert.equal(shapeFor(el('us'), '1 November 2026').value, '11/01/2026');
  assert.equal(shapeFor(el('eu'), '1990-04-12').value, '12.04.1990');
  assert.equal(shapeFor(el('d'), '1 November 2026').value, '2026-11-01', 'the 1st must not become 31 October');
  assert.match(String(shapeFor(el('us'), 'November 2026').error), /wants a date/);
  assert.equal(parseDay('November 2026'), null);
  assert.equal(parseDay('immediately'), null);
});

test('JAZZHR: "Postal", "over the age of 18", and a name question that is not "worked here"', () => {
  const dom = new JSDOM(`<input id="p" name="resumator-postal-value" placeholder="Postal">
    <label for="o">Are you over the age of 18?</label><select id="o"><option>-- No answer --</option><option>Yes</option><option>No</option></select>
    <label for="w">Have you ever worked under another name? If yes, what was it?</label><input id="w">`);
  const f = (id: string) => describeField(dom.window.document.getElementById(id), { visible: true });
  assert.equal(matchField(f('p'))?.key, 'postcode');
  const plan = planFill([f('o'), f('w')], { ...PROFILE, answers: { over18: 'Yes', workedHereBefore: 'No' } });
  assert.deepEqual(plan.fills.map((x: any) => x.key), ['over18']);
});

test('WORKABLE: a UK number rewritten as "020 …" is the same number, a different one is not', () => {
  const dom = new JSDOM('<input id="t" type="tel">');
  const el: any = dom.window.document.getElementById('t');
  el.value = '020 7946 0958';
  assert.equal(valueLanded(el, '+44 20 7946 0958'), true);
  el.value = '020 7946 0000';
  assert.equal(valueLanded(el, '+44 20 7946 0958'), false);
});

test('no control characters hide in the extension source (a lost backslash once made \b a backspace)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../extension/src/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), `${name} holds a control character`);
  }
});

test('ORACLE: Title and Yes/No pills drawn as <button role="radio"> are fields, and are answered', () => {
  const dom = new JSDOM(`<div>
    <ul role="radiogroup" aria-label="Title" class="cx-select-pills-container">
      <li role="presentation"><button type="button" role="radio" aria-checked="false"><span>Dr</span></button></li>
      <li role="presentation"><button type="button" role="radio" aria-checked="false"><span>Miss</span></button></li>
      <li role="presentation"><button type="button" role="radio" aria-checked="false"><span>Mr.</span></button></li>
      <li role="presentation"><button type="button" role="radio" aria-checked="false"><span>Ms.</span></button></li>
    </ul>
    <ul role="radiogroup" aria-label="Are you legally authorized to work in the US?">
      <li role="presentation"><button type="button" role="radio" aria-checked="false"><span>Yes</span></button></li>
      <li role="presentation"><button type="button" role="radio" aria-checked="false"><span>No</span></button></li>
    </ul></div>`);
  const pills = [...dom.window.document.querySelectorAll('[role="radio"]')]
    .map((el: any) => describeField(el, { visible: true }));
  assert.deepEqual([...new Set(pills.map((p: any) => p.type))], ['radio'], 'a pill was not read as a choice');
  const plan = planFill(pills, { ...PROFILE, salutation: 'Ms', answers: { workAuthorised: 'Yes' } });
  const chose = (q: RegExp) => plan.fills.find((f: any) => q.test(f.question || ''));
  assert.match(String(chose(/title/i)?.value), /^Ms/, 'the Title pill was not answered from the saved title');
  assert.equal(chose(/legally authorized/i)?.value, 'Yes', 'the work-authorisation pill was not answered');
});

test('ORACLE: a <button role="radio"> counts as a field, but a plain <button> menu opener does not', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../extension/src/content.js', import.meta.url), 'utf8');
  assert.match(text, /tag !== 'BUTTON' \|\| \/\^\(radio\|checkbox\)\$\/\.test/, 'content.js no longer keeps choice buttons');
});

test('FORD: "7 years" meets a ladder of 1+/3+/5+/7+, and the age question that names no age', () => {
  assert.equal(pickOption(['Less than 1 year', '1+ years', '3+ years', '5+ years', '7+ years', '9+ years'], '7'), 4);
  // A real pair of ranges with the value on the edge is still left for the person.
  assert.equal(pickOption(['$100,000 - $120,000', '$120,000 - $140,000'], '120000'), -1);
  const dom = new JSDOM(`<div>
    <ul role="radiogroup" aria-label="Do you meet the legal minimum age requirement for the location of the position in which you are applying?">
      <li><button type="button" role="radio" aria-checked="false"><span>Yes</span></button></li>
      <li><button type="button" role="radio" aria-checked="false"><span>No</span></button></li>
    </ul></div>`);
  const pills = [...dom.window.document.querySelectorAll('[role="radio"]')].map((el: any) => describeField(el, { visible: true }));
  const plan = planFill(pills, { ...PROFILE, answers: { over18: 'Yes' } });
  assert.equal(plan.fills[0]?.value, 'Yes', 'the minimum-age question was left for the person');
});

test('ORACLE: the country is set once per form, and the form is looked at again after it settles', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../extension/src/content.js', import.meta.url), 'utf8');
  // Picking the country a second time on the redrawn box failed, and a failed
  // pick empties it — which took Oracle's whole address block with it.
  assert.match(text, /state\.countrySet \? \[\] : plan\.fills\.filter/, 'the country can be picked twice again');
  assert.match(text, /if \(r\.done\.some\(\(d\) => d\.key === 'country'\)\) state\.countrySet = true;/);
  // Oracle's address block arrives after the first pass and nothing mutates
  // afterwards, so the watcher never wakes: one more look, 2.5 s later.
  assert.match(text, /setTimeout\(r, 2500\)\);\s*\n\s*await pass\(\);/, 'the second look after the first pass is gone');
});
