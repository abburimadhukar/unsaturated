/**
 * What runs on the employer's page.
 *
 * It does nothing until asked. The extension has no content script registered
 * for any site: the service worker injects this file into the tab the person is
 * looking at, after they click the toolbar button (or press Alt+Shift+F).
 * Filling is therefore always something a person started, on a page they are
 * looking at, in their own browser.
 *
 * The panel it draws is deliberately plain about three things: what was filled,
 * what was refused and why, and that we never press Submit.
 *
 * WRAPPED IN A FUNCTION, AND WHY THAT MATTERS
 *
 * `executeScript({files})` runs this as a classic script in the page's isolated
 * world, and a second press injects it AGAIN into the same world. At top level,
 * `const PANEL_ID` the second time is "Identifier 'PANEL_ID' has already been
 * declared" — so the button worked once per page load and then silently did
 * nothing. Inside a function, every press gets its own scope.
 *
 * The modules are loaded with a dynamic import: a classic script cannot use a
 * static `import`. They are web-accessible resources, which is what makes
 * `import(chrome.runtime.getURL(...))` legal here.
 */
(() => {
  const PANEL_ID = 'unsaturated-panel';
  const WATCH_KEY = '__unsaturatedWatch';

  /** jsdom has no layout, a browser does — so visibility is measured here only. */
  function isVisible(el) {
    if (el.type === 'file') return true;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  /**
   * Every field on the page — including the two kinds a plain search misses.
   *
   * INSIDE WEB COMPONENTS. SmartRecruiters builds its whole form from
   * <spl-input>, <spl-autocomplete> and <spl-phone-field>, each with its fields
   * in a shadow root: document.querySelectorAll found 0 fields on a form with
   * 14, and nothing was filled. Open shadow roots are searched too.
   *
   * MENUS THAT ARE NOT INPUTS. Rippling draws Gender, Hispanic/Latino, Veteran
   * and Disability as <div role="combobox">; they are fields to the person and
   * were invisible to the extension. A role="combobox" element with no real
   * field inside it is taken as one.
   */
  function allInputs(root = document, out = []) {
    // role="radio" too: Oracle draws Title, Yes/No and its other single
    // choices as pills — <li role="radio"> — with no <input> behind them.
    for (const el of root.querySelectorAll('input, textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]')) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (!['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type)) out.push(el);
      // A <button> that draws a CHOICE is a field: Oracle's Title and Yes/No
      // pills are <button role="radio">. A <button> that opens a PICKER is not
      // — SmartRecruiters' phone-code button opens its own list, and the number
      // typed with its + code already sets the country.
      } else if ((tag !== 'BUTTON' || /^(radio|checkbox)$/.test(el.getAttribute('role') || ''))
        && !el.querySelector('input, textarea, select') && !el.closest('#unsaturated-panel')) {
        out.push(el);
      }
    }
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot && host.id !== PANEL_ID) allInputs(host.shadowRoot, out);
    }
    return out;
  }

  /**
   * Breezy keeps work history and education in blocks that exist only after
   * "Add Position" / "Add Education" is pressed. One block is added per job and
   * school on the profile (up to four of each), each filled from its own entry.
   * These are links that add an empty block the person can delete — never a
   * submit, next or save button.
   */
  const HISTORY = [
    {
      host: /(^|\.)breezy\.hr$/,
      sections: [
        { list: 'experience', add: 'a[ng-click*="addPosition"]', field: '[ng-model^="candidatePosition."]' },
        { list: 'education', add: 'a[ng-click*="addEducation"]', field: '[ng-model^="candidateSchool."]' },
      ],
    },
    // SmartRecruiters: "Add experience entry" / "Add education entry" are
    // <spl-button> components, each press adds one block, and each block's
    // From / To are month-year calendars (spl-date-field ids exp-from-…,
    // exp-to-…, edu-from-…, edu-to-…). Mapped live on 19 September 2026.
    {
      host: /(^|\.)smartrecruiters\.com$/,
      sections: [
        { list: 'experience', addLabel: 'Add experience entry', from: 'exp-from-', to: 'exp-to-', startKey: 'jobStart', endKey: 'jobEnd', current: /currently work/i },
        { list: 'education', addLabel: 'Add education entry', from: 'edu-from-', to: 'edu-to-', startKey: 'eduStart', endKey: 'eduEnd', current: /currently (attend|study)/i },
      ],
    },
  ];

  /** Every element matching a selector, inside web components too. */
  function deepAll(selector, root = document, out = []) {
    out.push(...root.querySelectorAll(selector));
    // A component's OWN shadow root, not only its descendants'.
    if (root.shadowRoot && root.id !== PANEL_ID) deepAll(selector, root.shadowRoot, out);
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot && host.id !== PANEL_ID) deepAll(selector, host.shadowRoot, out);
    }
    return out;
  }

  /** A component's own button: <spl-button> keeps the real <button> inside. */
  const innerButton = (host) => (host && host.shadowRoot && host.shadowRoot.querySelector('button')) || host;

  /** The smallest block around a date field that holds its own Save button. */
  function blockAround(el) {
    let node = el.parentElement;
    while (node && !node.querySelector('[aria-label^="Save "]')) node = node.parentElement;
    return node;
  }

  async function componentBlocks(section, entries) {
    const blocks = () => deepAll(`spl-date-field[id^="${section.from}"]`).map(blockAround).filter(Boolean);
    for (let tries = 0; blocks().length < entries.length && tries <= entries.length; tries++) {
      const add = deepAll(`[aria-label="${section.addLabel}"]`)[0];
      if (!add) break;
      innerButton(add).click();
      await new Promise((r) => setTimeout(r, 800));
    }
    return blocks().slice(0, entries.length).map((block, i) => {
      const entry = entries[i];
      const dateBox = (prefix) => {
        const host = block.querySelector(`spl-date-field[id^="${prefix}"]`);
        return host ? deepAll('input[data-input]', host)[0] || null : null;
      };
      const tick = deepAll('spl-checkbox', block).find((c) => section.current.test(c.textContent || ''));
      return {
        list: section.list,
        entry,
        block,
        save: block.querySelector('[aria-label^="Save "]'),
        dates: [[section.startKey, dateBox(section.from), entry.start], [section.endKey, entry.current ? null : dateBox(section.to), entry.end]],
        current: entry.current && tick ? deepAll('input[type=checkbox]', tick)[0] || null : null,
        fields: allInputs(block),
      };
    });
  }

  async function historyBlocks(profile) {
    const recipe = HISTORY.find((h) => h.host.test(location.hostname));
    if (!recipe) return [];
    const out = [];
    for (const section of recipe.sections) {
      const entries = (profile[section.list] || []).slice(0, 4);
      if (!entries.length) continue;
      if (section.addLabel) {
        out.push(...await componentBlocks(section, entries));
        continue;
      }
      const blocks = () => {
        const seen = new Map();
        for (const f of document.querySelectorAll(section.field)) {
          const block = f.closest('.experience') || f.parentElement?.parentElement;
          if (block && !seen.has(block)) seen.set(block, []);
          if (block) seen.get(block).push(f);
        }
        return [...seen.values()];
      };
      const add = document.querySelector(section.add);
      for (let tries = 0; add && blocks().length < entries.length && tries < entries.length; tries++) {
        add.click();
        await new Promise((r) => setTimeout(r, 400));
      }
      blocks().slice(0, entries.length).forEach((fields, i) => out.push({ list: section.list, entry: entries[i], fields }));
    }
    return out;
  }

  /** The profile as ONE job or ONE school, so a block is filled from its own entry. */
  function profileFor(profile, block) {
    const place = { city: block.entry.location || '', region: '', country: '', postcode: '' };
    if (block.list === 'education') return { ...profile, ...place, education: [block.entry] };
    const job = block.entry;
    return { ...profile, ...place, experience: [job], currentCompany: job.company, currentTitle: job.title };
  }

  async function fileFrom(stored, fallbackType) {
    if (!stored || !stored.dataUrl) return null;
    const blob = await (await fetch(stored.dataUrl)).blob();
    return new File([blob], stored.name, { type: blob.type || fallbackType });
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // -------------------------------------------------------------------------
  // The panel
  // -------------------------------------------------------------------------

  function panel() {
    let host = document.getElementById(PANEL_ID);
    if (host) return host.shadowRoot;
    host = document.createElement('div');
    host.id = PANEL_ID;
    host.attachShadow({ mode: 'open' });
    host.shadowRoot.innerHTML = `
      <style>
        .card { position: fixed; top: 16px; right: 16px; width: 330px; max-height: 82vh; overflow: auto;
                background: #fff; color: #111; border: 1px solid #d5d5d5; border-radius: 10px;
                box-shadow: 0 8px 28px rgba(0,0,0,.18); font: 13px/1.45 system-ui, sans-serif; z-index: 2147483647; }
        .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: 600; }
        .hd .dot { width: 8px; height: 8px; border-radius: 50%; background: #e4572e; }
        .hd .x { margin-left: auto; border: 0; background: none; font-size: 16px; cursor: pointer; color: #666; }
        .body { padding: 10px 12px; }
        h4 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
        ul { margin: 0; padding-left: 16px; }
        li { margin: 2px 0; }
        .ok { color: #1a7f37; }
        .why { color: #777; }
        .note { margin-top: 10px; padding: 8px; background: #fff8ec; border: 1px solid #f0dcb8; border-radius: 6px; }
        .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        .btn { border: 1px solid #ccc; background: #fafafa; border-radius: 6px; padding: 5px 9px; font: inherit; font-size: 12px; cursor: pointer; }
        .btn.primary { background: #e4572e; border-color: #e4572e; color: #fff; }
        .msg { margin-top: 6px; color: #1a7f37; font-size: 12px; }
        .copy { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; border-bottom: 1px dashed #eee; cursor: pointer; }
        .copy span:first-child { color: #666; white-space: nowrap; }
        .copy span:last-child { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
        .copy:hover { background: #f6f6f6; }
        details summary { cursor: pointer; margin-top: 10px; font-size: 12px; color: #444; }
        .watch { margin-top: 8px; font-size: 12px; color: #555; }
      </style>
      <div class="card">
        <div class="hd"><span class="dot"></span> Unsaturated <button class="x" title="close">×</button></div>
        <div class="body">Reading the form…</div>
      </div>`;
    host.shadowRoot.querySelector('.x').onclick = () => {
      stopWatching();
      host.remove();
    };
    document.documentElement.appendChild(host);
    return host.shadowRoot;
  }

  /**
   * Plain names for boxes whose own words mislead. Breezy's date boxes carry
   * the placeholder "Company"; a password box is never shown by its value.
   */
  const KEY_NAMES = {
    eduStart: 'School start date', eduEnd: 'School end date', jobStart: 'Job start date', jobEnd: 'Job end date',
    password: 'Password', passwordConfirm: 'Password again', phoneCountry: 'Phone country code', confirmEmail: 'Email again',
    dateOfBirth: 'Date of birth', salutation: 'Title', nameSuffix: 'Name suffix', previousName: 'Previous last name',
    placeOfBirth: 'Place of birth', maritalStatus: 'Marital status', jobDescription: 'What you did in the job', eduDescription: 'About your studies',
  };

  function render(root, state, handlers) {
    const body = root.querySelector('.body');
    // What was FILLED is shown in full: it is the record of what was said in
    // the person's name. What is still TO DO is shown only while its box is on
    // the page — Ashby and Greenhouse redraw fields, and a box that has gone is
    // not something the person can act on.
    const here = (d) => !d.field?.el || d.field.el.isConnected;
    const done = state.done;
    const failed = state.failed.filter(here);
    const needs = needsYou(state.skipped.filter(here));
    const earlier = 0;
    const label = (f, s) => esc((s?.question || f?.label || f?.placeholder || f?.name || f?.id || 'field').slice(0, 70));
    const li = (items, fn) => items.map(fn).join('');
    const fromYou = done.filter((d) => /your saved|your answer for|your saved cover letter/.test(d.why) || d.choice);
    const details = done.filter((d) => !fromYou.includes(d));

    body.innerHTML = `
      <div><strong>${done.length}</strong> filled · <strong>${failed.length}</strong> failed ·
           <strong>${needs.length}</strong> left for you${earlier ? ` <span class="why">(+${earlier} on earlier pages)</span>` : ''}</div>
      ${fromYou.length ? `<h4>Your saved answers — check these</h4><ul>${li(fromYou, (d) => `<li class="ok">${label(d.field, d)} → <strong>${esc(String(d.committed ?? d.value).slice(0, 40))}</strong></li>`)}</ul>` : ''}
      ${details.length ? `<h4>Your details</h4><ul>${li(details, (d) => `<li class="ok">${KEY_NAMES[d.key] ? `${esc(KEY_NAMES[d.key])}${d.committed ? ` → <strong>${esc(d.committed)}</strong>` : ''}` : label(d.field)} <span class="why">(${esc(d.why)})</span></li>`)}</ul>` : ''}
      ${failed.length ? `<h4>Could not fill</h4><ul>${li(failed, (d) => `<li>${label(d.field)} — ${esc(d.reason)}</li>`)}</ul>` : ''}
      ${needs.length ? `<h4>Needs you</h4><ul>${li(needs, (s) => `<li>${label(s.field, s)} <span class="why">(${esc(s.reason)})</span></li>`)}</ul>` : ''}
      <div class="row">
        ${needs.length ? '<button class="btn primary" data-act="remember" title="Save what you have typed into the boxes above, so the next form that asks gets it filled">Remember what I typed</button>' : ''}
        <button class="btn" data-act="applied">${state.applied ? '✓ Marked as applied' : 'I submitted it'}</button>
        <button class="btn" data-act="tracker">My applications</button>
      </div>
      <div class="msg"></div>
      <details><summary>Copy a detail (for boxes it could not fill)</summary><div class="copies">${copyRows(state.profile)}</div></details>
      ${state.watching ? '<div class="watch">Following you to the next page of this form. <button class="btn" data-act="stop">Stop</button></div>' : ''}
      <div class="note">Check every answer, then press the employer's own submit button.
      This extension never submits an application for you.</div>`;

    for (const b of body.querySelectorAll('[data-act]')) b.onclick = () => handlers[b.dataset.act]?.(body.querySelector('.msg'));
    for (const row of body.querySelectorAll('.copy')) {
      row.onclick = () => copyText(row.dataset.value, body.querySelector('.msg'), row.dataset.name);
    }
  }

  /** Fields worth telling the person about: required, or a question we refused. */
  function needsYou(skipped) {
    return skipped
      // Already your country: nothing to do, so not listed as something to do.
      .filter((s) => s.reason !== 'set to your country')
      // A question nobody recognised is still listed when it is plainly a
      // question — required or ending in "?" — so a box is never left empty
      // without a word on the panel.
      .filter((s) => s.field.required
        || (s.reason === 'not recognised' && /\?|[*✱]/.test(s.question || ''))
        || /cover letter/i.test(s.reason)
        || ['narrative', 'consent'].includes(s.reason)
        || /no saved answer|matches none of the options|already/.test(s.reason))
      .slice(0, 16);
  }

  // -------------------------------------------------------------------------
  // Copy a detail — for the boxes no autofill can reach (a Workday date
  // picker, a vendor's own widget): the value, one click from the clipboard.
  // -------------------------------------------------------------------------

  function copyRows(profile) {
    const p = profile || {};
    const a = p.answers || {};
    const rows = [
      ['Name', [p.firstName, p.lastName].filter(Boolean).join(' ')],
      ['Email', p.email], ['Phone', p.phone],
      ['Location', [p.city, p.region, p.country].filter(Boolean).join(', ')],
      ['Address', p.address], ['Address line 2', p.address2], ['County', p.county], ['Postcode', p.postcode],
      ['Date of birth', p.dateOfBirth],
      ['LinkedIn', p.linkedin], ['GitHub', p.github], ['Website', p.website],
      ['Current title', p.currentTitle], ['Current company', p.currentCompany],
      ['Years of experience', a.yearsExperience], ['Highest qualification', a.education],
      ['Salary expectation', a.salaryExpectation], ['Notice period', a.noticePeriod],
      ...(p.experience || []).slice(0, 6).map((j) => [
        `${j.title || 'Job'}`,
        `${j.title || ''}${j.company ? ` at ${j.company}` : ''}${j.start ? ` (${j.start} – ${j.current ? 'present' : j.end || ''})` : ''}`,
      ]),
      ...(p.education || []).slice(0, 3).map((e) => [
        e.school || 'School',
        [[e.degree, e.discipline].filter(Boolean).join(' in '), e.school, e.end].filter(Boolean).join(', '),
      ]),
      ['Skills', Array.isArray(p.skills) ? p.skills.join(', ') : p.skills],
    ];
    return rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<div class="copy" data-name="${esc(k)}" data-value="${esc(v)}"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
      .join('');
  }

  async function copyText(value, msg, name) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Some pages refuse the clipboard API; the old way still works on a click.
      const t = document.createElement('textarea');
      t.value = value;
      t.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    if (msg) msg.textContent = `Copied ${name}.`;
  }

  // -------------------------------------------------------------------------
  // Remember what I typed
  //
  // The person answers a question the extension did not know, then presses
  // this. Their answer is saved so the next form asking the same thing gets it
  // filled — their own words, reused, never an answer made up for them.
  // -------------------------------------------------------------------------

  const SENSITIVE = new Set(['gender', 'pronouns', 'ethnicity', 'veteranStatus', 'disabilityStatus', 'yearOfBirth',
    'hispanicLatino', 'sexualOrientation', 'transgender', 'lgbtq']);

  /** The question as a phrase to look for next time: its words, without the marks. */
  function questionPhrase(s) {
    const raw = (s.question || s.field.label || s.field.placeholder || '').split('|')[0];
    return raw.replace(/\s+/g, ' ').replace(/^[\s*✱:]+|[\s*✱:]+$/g, '').replace(/\s*\(required\)$/i, '').trim().slice(0, 120);
  }

  function pickedOption(members) {
    const m = (members || []).find((x) => x.el && x.el.checked);
    if (!m) return '';
    const own = (m.label || '').split('|').map((x) => x.trim()).filter(Boolean);
    return (own[own.length - 1] || m.el.value || '').trim();
  }

  async function remember(state, currentAnswer) {
    const { profile } = await chrome.storage.local.get('profile');
    const p = profile || {};
    p.answers = { ...(p.answers || {}) };
    p.customAnswers = [...(p.customAnswers || [])];
    const saved = [];
    const leftOut = [];

    for (const s of state.skipped) {
      if (!s.field?.el?.isConnected) continue;
      if (['narrative', 'consent', 'honeypot'].includes(s.reason)) continue;
      const answer = s.members ? pickedOption(s.members) : currentAnswer(s.field.el);
      if (!answer || answer.length > 200) continue;
      if (s.answerKey && SENSITIVE.has(s.answerKey)) {
        leftOut.push(questionPhrase(s));
        continue;
      }
      // One of your details the profile did not have yet ("Preferred first
      // name", "Postcode"): saved AS that detail, so every form gets it — not as
      // a question/answer pair that only matches this one wording.
      if (s.factKey && !['resume', 'coverLetter', 'fullName', 'location', 'school', 'degree', 'discipline', 'gpa', 'graduationYear', 'skills'].includes(s.factKey)) {
        p[s.factKey] = answer;
        saved.push(questionPhrase(s));
        continue;
      }
      if (s.answerKey) {
        const yn = /^yes\b/i.test(answer) ? 'Yes' : /^no\b/i.test(answer) ? 'No' : answer;
        p.answers[s.answerKey] = yn;
        saved.push(questionPhrase(s));
        continue;
      }
      const match = questionPhrase(s);
      if (match.length < 4) continue;
      const existing = p.customAnswers.find((c) => c.match.toLowerCase() === match.toLowerCase());
      if (existing) existing.answer = answer;
      else p.customAnswers.push({ match, answer });
      saved.push(match);
    }
    await chrome.storage.local.set({ profile: p });
    state.profile = p;
    return { saved, leftOut };
  }

  // -------------------------------------------------------------------------
  // The application tracker
  // -------------------------------------------------------------------------

  /** Who is hiring, from the address — every vendor puts the company in it somewhere. */
  function companyFromUrl(u) {
    const url = new URL(u);
    const path = url.pathname.split('/').filter(Boolean);
    const host = url.hostname;
    const sub = host.split('.')[0];
    const tidy = (s) => decodeURIComponent(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    if (/greenhouse\.io$/.test(host)) return tidy(url.searchParams.get('for') || (path[0] === 'embed' ? '' : path[0]));
    if (/(lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com)$/.test(host)) return tidy(path[0] === 'j' ? '' : path[0]);
    if (/rippling\.com$/.test(host)) return tidy(path[0]);
    if (/(bamboohr\.com|recruitee\.com|teamtailor\.com|breezy\.hr|myworkdayjobs\.com|personio\.(de|com)|eightfold\.ai)$/.test(host)) return tidy(sub);
    return '';
  }

  function jobTitleOnPage() {
    const og = document.querySelector('meta[property="og:title"]')?.content;
    const h1 = document.querySelector('h1')?.textContent;
    return String(og || h1 || document.title || '').replace(/\s+/g, ' ').replace(/^job application for\s+/i, '').trim().slice(0, 120);
  }

  async function track(state, status) {
    const key = location.origin + location.pathname;
    const { applications = [] } = await chrome.storage.local.get('applications');
    let row = applications.find((a) => a.key === key);
    const now = new Date().toISOString();
    if (!row) {
      const site = document.querySelector('meta[property="og:site_name"]')?.content || '';
      // Greenhouse titles its page "Job Application for HR Specialist at G-P":
      // the employer's own name, where the address only has "globalizationpartners".
      const titled = /\bat\s+(.{2,60})$/i.exec(document.title.trim())?.[1] || '';
      row = {
        key,
        url: location.href,
        company: titled || site || companyFromUrl(location.href) || location.hostname,
        title: jobTitleOnPage(),
        status: 'filled',
        filledAt: now,
        notes: '',
      };
      applications.unshift(row);
    }
    row.filled = state.done.length;
    row.lastFilledAt = now;
    if (status === 'applied') {
      row.status = 'applied';
      row.appliedAt = now;
    }
    await chrome.storage.local.set({ applications: applications.slice(0, 2000) });
    return row;
  }

  // -------------------------------------------------------------------------
  // Filling, and following the person to the next page
  // -------------------------------------------------------------------------

  /**
   * Waits for the form to actually exist before reading it.
   *
   * Measured 18 September 2026: on Ashby the panel reported "0 filled · 0 left
   * for you" while the form was plainly on screen — the page draws itself after
   * loading, and the scan ran first. So it polls until the number of fields
   * stops growing, or gives up after eight seconds.
   */
  async function waitForFields(timeoutMs = 8000, settleMs = 600) {
    const count = () => allInputs().length;
    const deadline = Date.now() + timeoutMs;
    let last = count();
    let steadySince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const now = count();
      if (now !== last) {
        last = now;
        steadySince = Date.now();
        continue;
      }
      if (last > 1 && Date.now() - steadySince >= settleMs) return last;
    }
    return count();
  }

  function stopWatching() {
    const w = window[WATCH_KEY];
    if (w) {
      w.observer.disconnect();
      clearTimeout(w.timer);
      window[WATCH_KEY] = null;
    }
  }

  async function run() {
    stopWatching();
    const root = panel();
    await waitForFields();
    const [matcher, filler] = await Promise.all([
      import(chrome.runtime.getURL('src/matcher.js')),
      import(chrome.runtime.getURL('src/fill.js')),
    ]);
    const { profile } = await chrome.storage.local.get('profile');
    if (!profile) {
      root.querySelector('.body').innerHTML = 'No profile yet. Open the extension options and start from your résumé.';
      return;
    }
    const files = {
      resumeFile: await fileFrom(profile.resume, 'application/pdf'),
      coverLetterFile: await fileFrom(profile.coverLetter, 'application/pdf'),
    };

    const state = { done: [], failed: [], skipped: [], profile, applied: false, watching: false };
    const seen = new WeakSet();

    const handlers = {
      remember: async (msg) => {
        const { saved, leftOut } = await remember(state, filler.currentAnswer);
        msg.textContent = saved.length
          ? `Saved ${saved.length} answer${saved.length === 1 ? '' : 's'} — next time a form asks, it is filled.`
            + (leftOut.length ? ` Diversity answers are only saved from the options page.` : '')
          : 'Nothing new to remember — type your answers into the boxes first.';
      },
      applied: async (msg) => {
        await track(state, 'applied');
        state.applied = true;
        render(root, state, handlers);
        root.querySelector('.msg').textContent = 'Marked as applied in your tracker.';
      },
      tracker: () => chrome.runtime.sendMessage({ type: 'open-tracker' }),
      stop: () => {
        stopWatching();
        state.watching = false;
        render(root, state, handlers);
      },
    };

    /** One pass over the fields not seen before. The first pass is all of them. */
    const pass = async () => {
      const fresh = allInputs().filter((el) => !seen.has(el));
      if (!fresh.length) return 0;
      const describe = (els) => els.map((el) => matcher.describeField(el, { visible: isVisible(el) }));
      let plan = matcher.planFill(describe(fresh), state.profile);
      // THE COUNTRY FIRST, THEN LOOK AGAIN. Oracle redraws its whole address
      // block for the chosen country — India's "Pin Code" and "State" become the
      // UK's "Postcode" and "County" — so boxes filled in the same breath as the
      // country were thrown away with the old block (Arcadis, 19 Sep 2026).
      // ONCE PER FORM. Oracle redraws the country box after its address block
      // arrives; picking the country a second time failed on the redrawn box,
      // and a failed pick EMPTIES it — which took the address block, and the
      // address already in it, away with it (Arcadis, 20 Sep 2026).
      const countryFirst = state.countrySet ? [] : plan.fills.filter((f) => f.key === 'country');
      plan.fills = state.countrySet ? plan.fills.filter((f) => f.key !== 'country') : plan.fills;
      if (countryFirst.length) {
        for (const f of countryFirst) seen.add(f.field.el);
        const r = await filler.applyPlan({ fills: countryFirst, skipped: [] }, files);
        state.done.push(...r.done);
        state.failed.push(...r.failed);
        if (r.done.some((d) => d.key === 'country')) state.countrySet = true;
        await new Promise((res) => setTimeout(res, 1500));
        const now = allInputs().filter((el) => !seen.has(el));
        plan = matcher.planFill(describe(now), state.profile);
        plan.fills = plan.fills.filter((f) => f.key !== 'country');
        for (const el of now) seen.add(el);
      } else {
        for (const el of fresh) seen.add(el);
      }
      // A file is attached once. Greenhouse REPLACES its résumé input after
      // taking the file, and the replacement is a "new" field — without this the
      // watcher below would attach the résumé again every time it did.
      const attached = new Set(state.done.map((d) => d.key).filter((k) => k === 'resume' || k === 'coverLetter'));
      plan.fills = plan.fills.filter((f) => !attached.has(f.key));
      const result = await filler.applyPlan(plan, files);
      state.done.push(...result.done);
      state.failed.push(...result.failed);
      // On a later pass, a box that "already has a value" is almost always one
      // this run filled and the page then redrew as a new element. Listing it
      // as "check it" was noise measured on Ashby.
      state.skipped.push(...(state.passes ? result.skipped.filter((s) => !/^already/.test(s.reason)) : result.skipped));
      state.passes = (state.passes || 0) + 1;
      return result.done.length + result.failed.length + result.skipped.length;
    };

    // Work history and education blocks first, each from its own entry, so the
    // general pass below does not fill every block with the first job.
    for (const block of await historyBlocks(state.profile)) {
      for (const el of block.fields) seen.add(el);
      const special = new Set([...(block.dates || []).map(([, el]) => el), block.current].filter(Boolean));
      const descriptors = block.fields.filter((el) => !special.has(el)).map((el) => matcher.describeField(el, { visible: isVisible(el) }));
      const plan = matcher.planFill(descriptors, profileFor(state.profile, block));
      // "I currently work here" first — it switches the To date off — then the
      // calendar dates, then the rest.
      const extra = [];
      if (block.current && !block.current.checked) {
        extra.push({ field: matcher.describeField(block.current, { visible: true }), key: 'currentJob', value: 'Yes', why: 'your résumé says Present', choice: true, question: 'I currently work here' });
      }
      for (const [key, el, value] of block.dates || []) {
        if (el && value) extra.push({ field: matcher.describeField(el, { visible: true }), key, value, why: 'from your work history' });
      }
      plan.fills = [...extra, ...plan.fills];
      const result = await filler.applyPlan(plan, files);
      state.done.push(...result.done);
      state.failed.push(...result.failed);
      state.skipped.push(...result.skipped.filter((s) => s.field.required));
      // The block's own Save — keeps the entry, like Breezy's Add Position adds
      // it. Never the application's submit.
      if (block.save) {
        innerButton(block.save).click();
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    await pass();
    // ONE MORE LOOK, 2.5 s later. Oracle draws its address block (street, ZIP,
    // city, state, county) for the chosen country a moment after the rest of
    // the form, and if it arrives between the pass above and the watcher below
    // nothing changes afterwards — so no mutation ever wakes the watcher and a
    // whole address was left empty (Ford, 20 Sep 2026). A pass only ever looks
    // at boxes it has not seen, so a second one costs nothing when there is
    // nothing new.
    await new Promise((r) => setTimeout(r, 2500));
    await pass();
    // Tracked only where something was filled, so a frame with no form in it
    // (an embedded video, a cookie banner) does not become an "application".
    if (state.done.length) await track(state).catch(() => {});

    // FOLLOWING THE PERSON TO THE NEXT PAGE. Workday, Oracle and SmartRecruiters
    // ask their questions over several pages without reloading, so filling page
    // one and stopping left four pages of "My Experience" to the person. New
    // fields that appear are filled as they arrive, for up to half an hour.
    // Fields already seen are never touched again — a box the person cleared on
    // purpose stays cleared.
    if (window === window.top) {
      state.watching = true;
      const started = Date.now();
      let rounds = 0;
      const observer = new MutationObserver(() => {
        const w = window[WATCH_KEY];
        if (!w) return;
        clearTimeout(w.timer);
        w.timer = setTimeout(async () => {
          if (Date.now() - started > 30 * 60_000 || rounds > 40) {
            handlers.stop();
            return;
          }
          const before = state.done.length;
          if (await pass()) {
            rounds++;
            render(root, state, handlers);
            if (state.done.length > before) track(state).catch(() => {});
          }
        }, 1200);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window[WATCH_KEY] = { observer, timer: null };
    }
    render(root, state, handlers);
  }

  // Injected into every frame, but each frame fills only its own form.
  run().catch((err) => {
    const root = panel();
    root.querySelector('.body').textContent = `Could not read this form: ${err.message}`;
  });
})();
