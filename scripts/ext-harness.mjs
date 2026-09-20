/**
 * Shared pieces for driving the REAL extension on live forms: launching a
 * Chrome that loads it, saving a profile into it, pressing it on a tab, reading
 * its panel, and — the part that finds what is missing — AUDITING the page
 * afterwards: every box a person would see, and whether it still needs them.
 *
 * Nothing here presses submit, next, sign in or create account.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXT = path.resolve(process.env.EXT_DIR ?? path.join(HERE, '..', 'extension'));
export const CHROME = process.env.CHROME_PATH ?? path.join(HERE, '..', 'chrome/win64-153.0.8010.47/chrome-win64/chrome.exe');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1').toString('base64');

/**
 * Invented people with EVERY detail and answer filled — including the
 * voluntary ones — so a box left empty is the extension's gap, not a blank in
 * the test profile. The addresses are public landmarks so place searches find
 * something real. The password is a test value used nowhere.
 */
const COMMON_ANSWERS = {
  workAuthorised: 'Yes', needsSponsorship: 'No', over18: 'Yes',
  noticePeriod: '2 weeks', earliestStart: '1 November 2026', willingToRelocate: 'Yes', workPreference: 'Hybrid',
  commutable: 'Yes', salaryExpectation: '120000', yearsExperience: '7', englishLevel: 'Native',
  languages: 'English (native), Spanish (basic)', howDidYouHear: 'LinkedIn', referredBy: '',
  workedHereBefore: 'No', wasReferred: 'No', appliedBefore: 'No', currentlyEmployed: 'Yes', relativeAtCompany: 'No',
  nonCompete: 'No', backgroundCheck: 'Yes', driversLicense: 'Yes', willingToTravel: 'Yes', securityClearance: 'None',
  gender: 'Female', pronouns: 'She/her', ethnicity: 'White', hispanicLatino: 'No', sexualOrientation: 'Heterosexual',
  transgender: 'No', lgbtq: 'No', veteranStatus: 'I am not a protected veteran', disabilityStatus: 'No, I do not have a disability',
  yearOfBirth: '1990', relocationAssistance: 'No', mayContactEmployer: 'Yes', futureOpportunities: 'Yes', communities: 'None of the above', preferredLocation: 'London',
};

const HISTORY = {
  experience: [
    { company: 'Analytical Engines', title: 'Senior Data Engineer', location: '', start: '2021-03', end: '', current: true, description: 'Built data pipelines.' },
    { company: 'Difference Works', title: 'Data Engineer', location: '', start: '2018-06', end: '2021-02', current: false, description: 'Maintained ETL jobs.' },
  ],
  education: [{ school: 'University of Michigan', degree: 'Bachelor of Science', discipline: 'Computer Science', start: '2014-09', end: '2018-05', gpa: '3.7' }],
  skills: ['Python', 'SQL', 'Airflow', 'Spark'],
  resume: { name: 'ada-lovelace-cv.pdf', dataUrl: PDF },
  accountPassword: 'Test!Passw0rd-2026',
  tickConsents: false,
  customAnswers: [],
};

export const PERSONAS = {
  us: {
    salutation: 'Ms', firstName: 'Ada', middleName: 'King', lastName: 'Lovelace', preferredName: 'Ada',
    email: 'ada.lovelace.test@example.com', phone: '+1 415 555 0142',
    address: '1 Dr Carlton B Goodlett Pl', address2: 'Suite 200', city: 'San Francisco', county: 'San Francisco County', region: 'California', postcode: '94102', country: 'United States',
    dateOfBirth: '1990-04-12', placeOfBirth: 'Leeds, United Kingdom', maritalStatus: 'Single',
    linkedin: 'https://www.linkedin.com/in/example', github: 'https://github.com/example', website: 'https://example.com',
    currentCompany: 'Analytical Engines', currentTitle: 'Senior Data Engineer',
    answers: { ...COMMON_ANSWERS, nationality: 'American', timezone: 'PST (UTC-8)', visaDetails: 'US citizen; no sponsorship needed.', education: 'Bachelor of Science in Computer Science', currentSalary: '' },
    ...HISTORY,
  },
  uk: {
    salutation: 'Ms', firstName: 'Ada', middleName: 'King', lastName: 'Lovelace', preferredName: 'Ada',
    email: 'ada.lovelace.test@example.com', phone: '+44 20 7946 0958',
    address: '221B Baker Street', address2: 'Flat 1', city: 'London', county: 'Greater London', region: 'England', postcode: 'NW1 6XE', country: 'United Kingdom',
    dateOfBirth: '1990-04-12', placeOfBirth: 'Leeds, United Kingdom', maritalStatus: 'Single',
    linkedin: 'https://www.linkedin.com/in/example', github: 'https://github.com/example', website: 'https://example.com',
    currentCompany: 'Analytical Engines', currentTitle: 'Senior Data Engineer',
    answers: { ...COMMON_ANSWERS, nationality: 'British', timezone: 'GMT (UTC+0)', visaDetails: 'British citizen; no sponsorship needed.', education: 'Bachelor of Science in Computer Science', currentSalary: '' },
    ...HISTORY,
    education: [{ school: 'University of London', degree: 'Bachelor of Science', discipline: 'Mathematics', start: '2014-09', end: '2018-05', gpa: '' }],
  },
};

export async function launch({ headless = process.env.HEADLESS ? 'new' : false } = {}) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1300,1400'],
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 60_000 });
  const sw = await swTarget.worker();
  for (let i = 0; i < 50 && (await sw.evaluate(() => typeof chrome).catch(() => 'undefined')) !== 'object'; i++) await sleep(200);
  return { browser, sw };
}

export const setProfile = (sw, profile) => sw.evaluate((p) => chrome.storage.local.set({ profile: p }), profile);

/** Clicks the first link or button whose words contain one of `texts`. */
export async function clickText(page, texts, { exact = false } = {}) {
  for (const t of texts) {
    const xp = exact
      ? `xpath/.//*[self::a or self::button or self::ukg-button][normalize-space(.)="${t}"]`
      : `xpath/.//*[self::a or self::button or self::ukg-button][contains(normalize-space(.), "${t}")]`;
    for (const el of await page.$$(xp)) {
      const shown = await el.evaluate((e) => e.getClientRects().length > 0).catch(() => false);
      if (!shown) continue;
      await el.click().catch(() => {});
      return t;
    }
  }
  return null;
}

/**
 * Presses a cookie banner away. Ford's banner sits over the Apply button, so
 * without this the journey never reaches the form.
 */
export async function dismissCookies(page) {
  const hit = await page.evaluate(() => {
    const wanted = /^(click to )?(accept|allow|agree to)( all)?( cookies)?$|^(i )?(accept|agree)$|^got it$|^ok$|^accept all$|^allow all$/i;
    for (const el of document.querySelectorAll('button, a, [role=button]')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!wanted.test(t) || !el.getClientRects().length) continue;
      el.click();
      return t;
    }
    return null;
  }).catch(() => null);
  if (hit) await sleep(1500);
  return hit;
}

export const OPENERS = ['Apply for this job', 'Apply for this position', 'Apply to this job', 'Apply Now', 'Apply now', 'Apply Manually', "I'm interested", 'Apply'];

/** Presses the extension on the newest tab, the way the toolbar button does. */
export async function press(sw) {
  const tabId = await sw.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((t) => t.id)));
  return sw.evaluate(async (id) => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['src/content.js'] });
      return 'ok';
    } catch (err) {
      return String(err?.message ?? err).slice(0, 120);
    }
  }, tabId);
}

export const readPanel = (page) => page.evaluate(() => document.getElementById('unsaturated-panel')?.shadowRoot.querySelector('.body').innerText ?? null).catch(() => null);

export async function waitPanel(page, maxSeconds = 120) {
  let panel = null;
  for (let w = 0; w < maxSeconds; w++) {
    await sleep(1000);
    panel = await readPanel(page);
    if (panel && !/^Reading the form/.test(panel)) break;
  }
  await sleep(Number(process.env.EXTRA_WAIT || 2500));
  return readPanel(page);
}

/** The panel, as indented lines. */
export function panelLines(panel) {
  if (!panel) return ['  NO PANEL'];
  const out = [];
  let section = '';
  for (const line of panel.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (/^(YOUR SAVED ANSWERS|YOUR DETAILS|COULD NOT FILL|NEEDS YOU)/i.test(line)) { section = line.split(' —')[0].toUpperCase(); out.push(`  ${section}`); continue; }
    if (/^(Remember what I typed|I submitted it|My applications|Copy a detail|Following you|Check every answer)/.test(line)) { section = ''; continue; }
    if (/filled ·/.test(line) || section) out.push(`    ${line.slice(0, 170)}`);
  }
  return out;
}

/**
 * Every box a person would see, and whether it is still empty — found by
 * reading the page, not the extension's own report, so a box the extension
 * never noticed shows up too.
 */
export function audit(page) {
  return page.evaluate(() => {
    const PANEL = 'unsaturated-panel';
    const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const shown = (el) => {
      if (!el.getClientRects().length) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    };
    const els = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('input, textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]')) {
        if (el.closest(`#${PANEL}`)) continue;
        els.push(el);
      }
      for (const h of root.querySelectorAll('*')) if (h.shadowRoot && h.id !== PANEL) walk(h.shadowRoot);
    };
    walk(document);
    const labelOf = (el) => {
      const root = el.getRootNode();
      const bits = [];
      if (el.id) {
        const l = (root.querySelector ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) || document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) bits.push(l.textContent);
      }
      const wrap = el.closest('label');
      if (wrap) bits.push(wrap.textContent);
      for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        const n = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
        if (n) bits.push(n.textContent);
      }
      if (el.getAttribute('aria-label')) bits.push(el.getAttribute('aria-label'));
      if (!bits.length && el.getAttribute('placeholder')) bits.push(`[ph] ${el.getAttribute('placeholder')}`);
      if (!bits.length) {
        let p = el.parentElement;
        for (let i = 0; p && i < 4 && !bits.length; i++, p = p.parentElement) {
          const l = p.querySelector('label, legend, h3, h4, [class*="label"]');
          if (l && l !== el && !l.contains(el)) bits.push(l.textContent);
        }
      }
      if (!bits.length && root.host) bits.push(root.host.getAttribute('label') || root.host.tagName.toLowerCase());
      return squash(bits.join(' | ')).slice(0, 140);
    };
    // The question over a group of round buttons or tick boxes.
    const questionOf = (el) => {
      const fs = el.closest('fieldset');
      const lg = fs && fs.querySelector('legend');
      if (lg && squash(lg.textContent)) return squash(lg.textContent).slice(0, 140);
      const g = el.closest('[role="radiogroup"], [role="group"]');
      const lb = g && g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby'));
      if (lb) return squash(lb.textContent).slice(0, 140);
      if (g && g.getAttribute('aria-label')) return g.getAttribute('aria-label');
      let p = el.parentElement;
      for (let i = 0; p && i < 7; i++, p = p.parentElement) {
        const n = p.querySelectorAll('input[type=radio], input[type=checkbox], [role=radio], [role=checkbox]').length;
        if (n < 2) continue;
        for (const h of p.querySelectorAll('legend, h1, h2, h3, h4, label, p, span, div')) {
          if (h.querySelector('input, [role=radio], [role=checkbox]')) continue;
          const t = squash(h.textContent);
          if (t.length > 10) return t.slice(0, 140);
        }
      }
      return labelOf(el);
    };
    const out = [];
    const groups = new Map();
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const type = tag === 'input' ? (el.type || 'text') : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : role;
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      if (tag !== 'input' && tag !== 'select' && tag !== 'textarea' && el.querySelector('input, select, textarea')) continue;
      const isChoice = type === 'radio' || type === 'checkbox';
      // Real radios are often hidden behind styled ones: judge those by their label.
      const vis = type === 'file' ? true : isChoice ? (shown(el) || (el.labels && [...el.labels].some(shown)) || shown(el.parentElement || el)) : shown(el);
      if (!vis) continue;
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*|required/i.test(labelOf(el));
      if (isChoice) {
        const q = questionOf(el);
        const key = (tag === 'input' && type === 'radio' && el.name) ? `name:${el.name}` : `q:${q}`;
        if (!groups.has(key)) groups.set(key, { kind: type, question: q, options: [], checked: [], required: false });
        const g = groups.get(key);
        const opt = squash((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.parentElement?.textContent || el.value).slice(0, 60);
        g.options.push(opt);
        const on = tag === 'input' ? el.checked : el.getAttribute('aria-checked') === 'true';
        if (on) g.checked.push(opt);
        g.required = g.required || required;
        continue;
      }
      let value = '';
      let options = [];
      if (tag === 'select') {
        const o = el.selectedOptions[0];
        value = o && o.value && !/^\?/.test(o.value) && !/^(select|choose|please|--)/i.test(o.textContent.trim()) ? o.textContent.trim() : '';
        options = [...el.options].map((x) => squash(x.textContent)).filter(Boolean).slice(0, 12);
        // BambooHR: the <select> is hidden; its button shows the choice.
        const button = !value && el.closest('[data-fabric-component="Select"]')?.querySelector('button[aria-haspopup]');
        if (button && !/^[–—-]*\s*select/i.test(squash(button.textContent))) value = squash(button.textContent);
      } else if (type === 'file') {
        value = el.files && el.files.length ? el.files[0].name : '';
      } else if (tag !== 'input' && tag !== 'textarea') {
        value = squash(el.textContent);
        if (/^(select|choose|please select|--|search)/i.test(value)) value = '';
      } else {
        value = el.value;
        if (!value && (role === 'combobox' || el.getAttribute('aria-autocomplete'))) {
          let c = el.parentElement;
          for (let i = 0; c && i < 4; i++, c = c.parentElement) {
            const sv = c.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"]');
            if (sv) { value = squash(sv.textContent); break; }
          }
        }
      }
      out.push({ kind: type, label: labelOf(el), required, value: type === 'password' && value ? '••••' : squash(value).slice(0, 70), options, id: el.id || el.name || el.getAttribute('data-automation-id') || '' });
    }
    for (const g of groups.values()) {
      out.push({ kind: `${g.kind}-group`, label: g.question, required: g.required, value: g.checked.join(' + '), options: g.options.slice(0, 12) });
    }
    return out;
  });
}

/** Prints the audit: what is still empty first, then (with SHOW_FILLED) what was filled. */
export function auditLines(rows) {
  const empty = rows.filter((r) => !r.value);
  const filled = rows.filter((r) => r.value);
  const out = [`  AUDIT: ${filled.length} boxes hold a value, ${empty.length} still empty`];
  for (const r of empty) {
    out.push(`    EMPTY${r.required ? '*' : ' '} (${r.kind}) ${r.label || '(no label)'}${r.id ? ` [${String(r.id).slice(0, 40)}]` : ''}${r.options.length ? `  :: ${r.options.join(' / ').slice(0, 220)}` : ''}`);
  }
  if (process.env.SHOW_FILLED) for (const r of filled) out.push(`    filled (${r.kind}) ${r.label} = ${r.value}`);
  return out;
}

/** Journeys that need more than one Apply press to reach the form. */
export const JOURNEYS = {
  oracle: async (p) => {
    // The job page draws itself slowly; press Apply once it is there.
    await dismissCookies(p);
    await p.waitForFunction(() => /apply/i.test(document.body?.innerText || ''), { timeout: 45000 }).catch(() => {});
    await sleep(3000);
    for (let i = 0; i < 3 && !/\/apply/.test(p.url()); i++) {
      await clickText(p, ['Apply Now', 'Apply']);
      await p.waitForFunction(() => /\/apply/.test(location.pathname), { timeout: 12000 }).catch(() => {});
    }
    for (let attempt = 0; attempt < 2 && !/\/apply\/(section|form)|\/apply\/?$/.test(p.url()) ; attempt++) {
      await p.waitForSelector('input[type=email]', { visible: true, timeout: 20000 }).catch(() => {});
      await p.click('input[type=email]', { clickCount: 3 }).catch(() => {});
      await p.type('input[type=email]', `unsat.probe.${Date.now()}@example.com`).catch(() => {});
      const tick = await p.$('input[type=checkbox]');
      if (tick) await p.evaluate((c) => { if (!c.checked) (c.labels?.[0] || c).click(); }, tick);
      await sleep(800);
      await clickText(p, ['Next'], { exact: true });
      await p.waitForFunction(() => !/\/apply\/email/.test(location.pathname), { timeout: 20000 }).catch(() => {});
      if (!/\/apply\/email/.test(p.url())) break;
    }
    await sleep(10000);
  },
  workday: async (p) => {
    await dismissCookies(p);
    await p.waitForFunction(() => /apply/i.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
    await sleep(2000);
    await clickText(p, ['Apply']);
    await sleep(5000);
    await clickText(p, ['Apply Manually']);
    await sleep(6000);
  },
  generic: async (p) => {
    await dismissCookies(p);
    // A page that is already the form (…/apply, …/application) is left alone:
    // pressing "Apply" there can navigate away. A job page with a search box
    // and a job-alert sign-up is NOT a form: it needs an email box or a name
    // box before we believe it, or Eightfold's job page is mistaken for one.
    const formAlready = await p.evaluate(() => {
      // Shadow roots too: BambooHR's form is inside web components, and a page
      // that "has no boxes" was mistaken for a job posting and clicked away.
      const all = [];
      const walk = (root) => {
        for (const e of root.querySelectorAll('input:not([type=hidden]), textarea, select')) all.push(e);
        for (const h of root.querySelectorAll('*')) if (h.shadowRoot) walk(h.shadowRoot);
      };
      walk(document);
      const boxes = all.filter((e) => e.getClientRects().length);
      const words = (e) => `${e.name} ${e.id} ${e.placeholder || ''} ${e.getAttribute('aria-label') || ''}`.toLowerCase();
      const personal = boxes.some((e) => e.type === 'email' || /\b(first|last|family|given)[_\- ]?name\b|\bemail\b/.test(words(e)));
      return boxes.length >= 4 && personal;
    }).catch(() => false);
    if (!formAlready) {
      await clickText(p, OPENERS);
      await sleep(5000);
      // Some sites (Eightfold) open the form in a new tab.
      const pages = await p.browser().pages();
      const latest = pages[pages.length - 1];
      if (latest !== p) { await latest.bringToFront(); await sleep(4000); return latest; }
    }
  },
};

export function journeyFor(url) {
  if (/oraclecloud\.com/.test(url)) return JOURNEYS.oracle;
  if (/myworkdayjobs\.com/.test(url)) return JOURNEYS.workday;
  return JOURNEYS.generic;
}

