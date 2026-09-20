/**
 * Your details and your answers, kept in this browser's extension storage.
 *
 * START FROM YOUR RÉSUMÉ. Choosing a file reads it here (resume.js, built from
 * the website's own résumé reader, with pdf.js bundled — nothing is uploaded),
 * fills every EMPTY box from it, and saves. Boxes filled that way stay
 * highlighted until the person edits them, because a value read by a program
 * deserves a look before it is sent to an employer in their name. A box the
 * person already filled is never overwritten.
 *
 * The résumé itself is held as a data URL so the content script can rebuild a
 * real File for the employer's file input without any network call.
 *
 * The answer section is BUILT FROM answers.js rather than written out by hand.
 * One list drives both the boxes you fill in and the matching against an
 * employer's question, so a question type cannot exist in one and not the other.
 */
import { ANSWER_FIELDS } from './answers.js';

const TEXT_FIELDS = [
  'firstName', 'middleName', 'lastName', 'preferredName', 'email', 'phone',
  'city', 'region', 'country', 'postcode', 'address', 'address2', 'county',
  'salutation', 'nameSuffix', 'dateOfBirth', 'previousName', 'placeOfBirth', 'maritalStatus',
  'linkedin', 'github', 'website', 'currentCompany', 'currentTitle', 'coverLetterText',
  'accountPassword',
];

const $ = (id) => document.getElementById(id);

/** Ids of boxes filled from the résumé and not yet looked at. Saved with the profile. */
const review = new Set();

/** What storage held when this page loaded, to tell our edits from a form's "Remember". */
let loaded = { answers: {}, customMatches: new Set() };

function markFromResume(el, id) {
  el.classList.add('from-resume');
  review.add(id);
}

function watchReview(el, id) {
  el.addEventListener('input', () => {
    el.classList.remove('from-resume');
    review.delete(id);
  });
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

function answerInput(field, value) {
  const id = `answer-${field.key}`;
  const wrap = document.createElement('div');
  wrap.className = 'answer';
  const label = document.createElement('label');
  label.setAttribute('for', id);
  label.textContent = field.label;
  wrap.append(label);

  let input;
  if (field.type === 'choice') {
    input = document.createElement('select');
    const options = field.sensitive ? ['', 'Yes', 'No', 'Prefer not to say'] : ['', 'Yes', 'No'];
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = option || '— leave for me to answer —';
      input.append(el);
    }
    input.value = options.includes(value) ? value : '';
  } else {
    input = document.createElement('input');
    input.value = value ?? '';
    input.placeholder = field.sensitive ? 'blank = never answered for you' : '';
  }
  input.id = id;
  watchReview(input, id);
  wrap.append(input);

  if (field.help) {
    const help = document.createElement('p');
    help.className = 'help';
    help.textContent = field.help;
    wrap.append(help);
  }
  return wrap;
}

function buildAnswers(saved = {}) {
  const ordinary = $('answers');
  const sensitive = $('answers-sensitive');
  ordinary.replaceChildren();
  sensitive.replaceChildren();
  for (const field of ANSWER_FIELDS) {
    // Derived answers have no box of their own: they follow from the others.
    if (field.derived) continue;
    (field.sensitive ? sensitive : ordinary).append(answerInput(field, saved[field.key]));
  }
}

// ---------------------------------------------------------------------------
// Lists: jobs, schools, your own questions
// ---------------------------------------------------------------------------

const JOB_FIELDS = [
  ['title', 'Title'], ['company', 'Company'], ['location', 'Location'],
  ['start', 'Start (e.g. 2021-03)'], ['end', 'End (blank if current)'],
  ['description', 'What you did there (for forms with a description box per job)'],
];
const SCHOOL_FIELDS = [
  ['school', 'School'], ['degree', 'Degree'], ['discipline', 'Discipline / major'],
  ['start', 'Start'], ['end', 'End or graduation'], ['gpa', 'GPA'],
];

function itemRow(kind, fields, value = {}, fromResume = false) {
  const box = document.createElement('div');
  box.className = `item ${kind}`;
  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `<span>${kind === 'job' ? 'Job' : 'School'}</span>`;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = 'Remove';
  remove.onclick = () => box.remove();
  head.append(remove);
  box.append(head);

  const row = document.createElement('div');
  row.className = 'row';
  row.style.flexWrap = 'wrap';
  for (const [key, text] of fields) {
    const cell = document.createElement('div');
    cell.style.flex = key === 'description' ? '1 1 100%' : key === 'title' || key === 'company' || key === 'school' || key === 'degree' ? '1 1 45%' : '1 1 28%';
    const label = document.createElement('label');
    label.textContent = text;
    const input = document.createElement(key === 'description' ? 'textarea' : 'input');
    if (key === 'description') input.rows = 3;
    input.dataset.key = key;
    input.value = value[key] ?? '';
    if (fromResume) input.classList.add('from-resume');
    input.addEventListener('input', () => input.classList.remove('from-resume'));
    cell.append(label, input);
    row.append(cell);
  }
  box.append(row);
  if (kind === 'job') {
    const current = document.createElement('label');
    current.className = 'check';
    current.innerHTML = '<input type="checkbox" data-key="current"> I work here now';
    current.querySelector('input').checked = Boolean(value.current);
    box.append(current);
  }
  return box;
}

function readItems(containerId) {
  return [...$(containerId).querySelectorAll('.item')].map((box) => {
    const out = {};
    for (const input of box.querySelectorAll('[data-key]')) {
      out[input.dataset.key] = input.type === 'checkbox' ? input.checked : input.value.trim();
    }
    if (out.current) out.end = '';
    return out;
  }).filter((x) => Object.entries(x).some(([k, v]) => k !== 'current' && v));
}

function buildList(containerId, kind, fields, items, fromResume = false) {
  const box = $(containerId);
  box.replaceChildren(...items.map((v) => itemRow(kind, fields, v, fromResume)));
}

function customRow(pair = { match: '', answer: '' }) {
  const row = document.createElement('div');
  row.className = 'row custom-row';
  row.style.marginBottom = '6px';
  row.innerHTML = `
    <div><input class="custom-match" placeholder="words in the question, e.g. MT4"></div>
    <div><input class="custom-answer" placeholder="your answer"></div>`;
  row.querySelector('.custom-match').value = pair.match ?? '';
  row.querySelector('.custom-answer').value = pair.answer ?? '';
  return row;
}

function buildCustom(pairs = []) {
  const box = $('custom');
  box.replaceChildren();
  for (const pair of [...pairs, {}, {}, {}].slice(0, Math.max(pairs.length + 2, 3))) box.append(customRow(pair));
}

// ---------------------------------------------------------------------------
// Load and save
// ---------------------------------------------------------------------------

async function load() {
  const { profile } = await chrome.storage.local.get('profile');
  const p = profile || {};
  loaded = {
    answers: { ...(p.answers || {}) },
    customMatches: new Set((p.customAnswers || []).map((c) => c.match.toLowerCase())),
  };
  buildAnswers(p.answers ?? {});
  buildCustom(p.customAnswers ?? []);
  const pending = new Set(p.review || []);
  buildList('jobs', 'job', JOB_FIELDS, p.experience || [], pending.has('jobs'));
  buildList('schools', 'school', SCHOOL_FIELDS, p.education || [], pending.has('schools'));
  for (const key of TEXT_FIELDS) $(key).value = p[key] || '';
  $('skills').value = Array.isArray(p.skills) ? p.skills.join(', ') : p.skills || '';
  $('tickConsents').checked = Boolean(p.tickConsents);
  if (p.resume) $('resumeName').textContent = `Stored: ${p.resume.name}`;
  if (p.coverLetter) $('coverLetterName').textContent = `Stored: ${p.coverLetter.name}`;
  review.clear();
  for (const id of pending) {
    review.add(id);
    const el = $(id);
    if (el) el.classList.add('from-resume');
  }
}

function dataUrlOf(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Saves what is on the page, without losing what a form saved meanwhile.
 *
 * "Remember what I typed" on an employer's form writes to the same storage
 * while this page may be open. A plain overwrite would throw those answers
 * away, so an answer that changed in storage since this page loaded is kept
 * unless the person changed that box here too.
 */
async function save({ quiet = false } = {}) {
  const { profile: current } = await chrome.storage.local.get('profile');
  const stored = current || {};
  const profile = { ...stored };
  // A password is kept exactly as typed: a space at either end is part of it.
  for (const key of TEXT_FIELDS) profile[key] = key === 'accountPassword' ? $(key).value : $(key).value.trim();

  profile.answers = {};
  for (const field of ANSWER_FIELDS) {
    if (field.derived) continue;
    const here = $(`answer-${field.key}`).value.trim();
    const there = (stored.answers || {})[field.key] || '';
    const before = loaded.answers[field.key] || '';
    const value = here !== before ? here : there;
    if (value) profile.answers[field.key] = value;
  }

  const pairs = [...document.querySelectorAll('.custom-row')]
    .map((row) => ({
      match: row.querySelector('.custom-match').value.trim(),
      answer: row.querySelector('.custom-answer').value.trim(),
    }))
    .filter((pair) => pair.match && pair.answer);
  const onPage = new Set(pairs.map((x) => x.match.toLowerCase()));
  const addedElsewhere = (stored.customAnswers || [])
    .filter((c) => !loaded.customMatches.has(c.match.toLowerCase()) && !onPage.has(c.match.toLowerCase()));
  profile.customAnswers = [...pairs, ...addedElsewhere];

  profile.experience = readItems('jobs');
  profile.education = readItems('schools');
  profile.skills = $('skills').value.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  profile.tickConsents = $('tickConsents').checked;
  const listFlags = [...review].filter((id) => id === 'jobs' || id === 'schools');
  const stillYellow = (id) => document.querySelector(`#${id} .from-resume`);
  profile.review = [...review].filter((id) => !listFlags.includes(id) || stillYellow(id));

  const letter = $('coverLetterFile').files[0];
  if (letter) profile.coverLetter = { name: letter.name, dataUrl: await dataUrlOf(letter) };

  await chrome.storage.local.set({ profile });
  loaded = {
    answers: { ...profile.answers },
    customMatches: new Set(profile.customAnswers.map((c) => c.match.toLowerCase())),
  };
  if (!quiet) {
    const saved = $('saved');
    const answered = Object.keys(profile.answers).length;
    const askable = ANSWER_FIELDS.filter((f) => !f.derived).length;
    saved.textContent = `Saved — ${answered} of ${askable} questions answered`
      + (profile.customAnswers.length ? `, ${profile.customAnswers.length} of your own` : '');
    setTimeout(() => (saved.textContent = ''), 4000);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Start from your résumé
// ---------------------------------------------------------------------------

const DETAIL_LABELS = {
  firstName: 'first name', middleName: 'middle name', lastName: 'last name', email: 'email', phone: 'phone',
  linkedin: 'LinkedIn', github: 'GitHub', website: 'website', city: 'city', region: 'state/region',
  country: 'country', currentCompany: 'current company', currentTitle: 'current title',
};

async function readResumeFile(file) {
  const status = $('readStatus');
  status.innerHTML = '<p class="note">Reading your résumé…</p>';

  // The file is kept first, whatever happens when it is read: it is what gets
  // attached to applications, and a scan with no text is still a résumé.
  const { profile: current } = await chrome.storage.local.get('profile');
  const kept = { ...(current || {}), resume: { name: file.name, dataUrl: await dataUrlOf(file) } };
  await chrome.storage.local.set({ profile: kept });
  $('resumeName').textContent = `Stored: ${file.name}`;

  let read;
  try {
    const { readResume } = await import('./resume.js');
    read = await readResume(file, {
      lib: chrome.runtime.getURL('vendor/pdf.min.mjs'),
      worker: chrome.runtime.getURL('vendor/pdf.worker.min.mjs'),
    });
  } catch (err) {
    status.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'note warn';
    p.textContent = `Your résumé is stored for attaching, but it could not be read: ${err.message}. Fill the boxes in by hand.`;
    status.append(p);
    return;
  }

  const found = [];
  const skippedFull = [];
  const fillBox = (id, value, name) => {
    const el = $(id);
    if (!el || !value) return;
    if (el.value.trim()) {
      if (el.value.trim() !== String(value).trim()) skippedFull.push(name);
      return;
    }
    el.value = value;
    markFromResume(el, id);
    found.push(name);
  };

  for (const [key, value] of Object.entries(read.profile.details)) fillBox(key, value, DETAIL_LABELS[key] || key);
  const answerNames = { yearsExperience: 'years of experience', education: 'highest qualification', languages: 'languages', currentlyEmployed: 'currently employed' };
  for (const [key, value] of Object.entries(read.profile.answers)) fillBox(`answer-${key}`, value, answerNames[key] || key);

  if (read.profile.experience.length) {
    if (!readItems('jobs').length) {
      buildList('jobs', 'job', JOB_FIELDS, read.profile.experience, true);
      review.add('jobs');
      found.push(`${read.profile.experience.length} job${read.profile.experience.length === 1 ? '' : 's'}`);
    } else skippedFull.push('work experience');
  }
  if (read.profile.education.length) {
    if (!readItems('schools').length) {
      buildList('schools', 'school', SCHOOL_FIELDS, read.profile.education, true);
      review.add('schools');
      found.push(`${read.profile.education.length} school${read.profile.education.length === 1 ? '' : 's'}`);
    } else skippedFull.push('education');
  }
  if (read.profile.skills.length) fillBox('skills', read.profile.skills.join(', '), `${read.profile.skills.length} skills`);

  await save({ quiet: true });

  const missing = Object.keys(DETAIL_LABELS)
    .filter((k) => k !== 'middleName' && !$(k).value.trim())
    .map((k) => DETAIL_LABELS[k]);

  status.replaceChildren();
  const box = document.createElement('div');
  box.className = read.warning ? 'note warn' : 'note';
  const lines = [];
  if (read.warning) lines.push(read.warning);
  lines.push(found.length
    ? `Read from your résumé and saved: ${found.join(', ')}. Check the yellow boxes — a program read them.`
    : 'Nothing new was read from your résumé — every box it could fill was already filled.');
  if (skippedFull.length) lines.push(`Kept what you had already typed for: ${skippedFull.join(', ')}.`);
  if (missing.length) lines.push(`Not on your résumé, so please type in: ${missing.join(', ')}.`);
  lines.push(...read.profile.notes);
  lines.push('Then answer the questions employers ask (sponsorship, notice, salary) further down — those are never read from a résumé.');
  const ul = document.createElement('ul');
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.append(li);
  }
  box.append(ul);
  status.append(box);
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

$('export').onclick = async (e) => {
  e.preventDefault();
  const all = await chrome.storage.local.get(['profile', 'applications']);
  const blob = new Blob([JSON.stringify({ version: 1, ...all }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `unsaturated-profile-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('import').onclick = (e) => {
  e.preventDefault();
  $('importFile').click();
};
$('importFile').onchange = async () => {
  const file = $('importFile').files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.profile || typeof data.profile !== 'object') throw new Error('no profile in that file');
    if (!confirm('Replace the details on this page with the ones in that backup?')) return;
    await chrome.storage.local.set({ profile: data.profile, ...(Array.isArray(data.applications) ? { applications: data.applications } : {}) });
    await load();
    $('saved').textContent = 'Backup loaded.';
  } catch (err) {
    alert(`That file could not be loaded: ${err.message}`);
  }
};

// ---------------------------------------------------------------------------

for (const key of [...TEXT_FIELDS, 'skills']) watchReview($(key), key);
$('add-job').onclick = () => $('jobs').append(itemRow('job', JOB_FIELDS));
$('add-school').onclick = () => $('schools').append(itemRow('school', SCHOOL_FIELDS));
$('add-custom').onclick = () => $('custom').append(customRow());
$('showPassword').onclick = () => {
  const box = $('accountPassword');
  box.type = box.type === 'password' ? 'text' : 'password';
  $('showPassword').textContent = box.type === 'password' ? 'Show' : 'Hide';
};
$('resume').addEventListener('change', () => {
  const file = $('resume').files[0];
  if (file) readResumeFile(file);
});
$('save').addEventListener('click', () => save());

load();
