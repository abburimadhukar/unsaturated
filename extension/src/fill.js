/**
 * Putting a value into a box so the page believes it.
 *
 * WHY THIS IS NOT `el.value = "x"`
 *
 * Every vendor surveyed on 17 September 2026 renders its form with React
 * (Greenhouse's markup carries `remix-css-…` class names, Ashby and Rippling are
 * React apps). React keeps its own copy of the value and reads it back from its
 * own tracker, so a plain assignment is either ignored or wiped on the next
 * render: the person sees their details appear and then vanish when they click
 * Submit, which is worse than not filling at all.
 *
 * The fix is the one every autofill tool converges on: call the NATIVE value
 * setter — the one React's tracker does not shadow — and then dispatch the same
 * `input` and `change` events a keystroke produces, so the page's own handlers
 * run exactly as if the person had typed.
 *
 * Nothing here decides WHAT to fill. That is matcher.js, which is pure and
 * tested. This module only writes, and reports what it could not write.
 */

import { choiceWords, meaningOf, bandFor } from './answers.js';

const nativeSetter = (el) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value')?.set;
};

function fire(el, types = ['input', 'change']) {
  for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
}

/**
 * Types a value the way a keystroke would, and says whether it stuck.
 *
 * TWO THINGS LEARNED FROM A LIVE GREENHOUSE FORM, 17 September 2026.
 *
 * It does NOT blur. Greenhouse's phone box is intl-tel-input
 * (`class="iti__tel-input"`), and blurring it straight after a programmatic set
 * left it empty — the widget re-reads its own state and throws the value away.
 * Leaving focus where the person's next click will move it anyway costs nothing.
 *
 * It does not demand the value back CHARACTER FOR CHARACTER. The same widget
 * rewrites "+1 415 555 0142" as "+1 415-555-0142", and a strict comparison
 * reported a perfectly filled field as a failure. A phone number is the same
 * number whatever the punctuation, so the check compares digits for tel fields.
 */
export function setValue(el, value) {
  el.focus?.();
  const setter = nativeSetter(el);
  if (setter) setter.call(el, value);
  else el.value = value;
  fire(el);
  return valueLanded(el, value);
}

/** Did the page keep what we put in, allowing for its own reformatting? */
export function valueLanded(el, value) {
  const now = String(el.value ?? '');
  if (now === value) return true;
  if (!now) return false;
  const digits = (s) => s.replace(/\D+/g, '');
  // Rippling's phone box is `type="text" inputmode="tel" data-input="phone_number"`
  // and rewrites what it is given; judging it as plain text reported a perfectly
  // filled number as a failure.
  const phoneish = `${el.id} ${el.name} ${el.getAttribute('data-input') ?? ''} ${el.getAttribute('data-testid') ?? ''} ${el.placeholder ?? ''}`;
  if (el.type === 'tel' || el.getAttribute('inputmode') === 'tel' || /phone|tel/i.test(phoneish)) {
    const a = digits(now);
    const b = digits(value);
    if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
    // Workable, once its flag is +44, rewrites "+44 20 7946 0958" as the
    // national "020 7946 0958": the same number with the trunk 0 for the code.
    const national = a.replace(/^0+/, '');
    return national.length >= 7 && b.endsWith(national);
  }
  // A page is allowed to reformat what it was given, and several do:
  // Breezy's salary box runs `ng-change="stripNonNumeric()"`, so "140,000 CAD"
  // becomes "140000" — filled correctly, and reported as a failure by a strict
  // comparison. The test is whether what remains is OUR answer with the page's
  // own formatting removed, never a different answer.
  const squashed = (v) => String(v).replace(/[\s,._-]/g, '').toLowerCase();
  if (squashed(now) === squashed(value)) return true;
  const digitsOnly = (v) => String(v).replace(/\D+/g, '');
  if (digitsOnly(value) && digitsOnly(now) === digitsOnly(value)) return true;
  // Some widgets trim or collapse whitespace; anything else is a real mismatch.
  return now.trim() === value.trim();
}


/**
 * The same answer, in the shape THIS box accepts.
 *
 * Three real cases from live forms, 18 September 2026:
 *   Breezy's  "Desired Salary" is <input type=number>, and "140,000 CAD"
 *             is not a number, so the box stayed empty.
 *   Personio's "Year of birth" is <input type=date>, which wants 1990-01-01.
 *   Workday's  date boxes want the same.
 *
 * A year alone is NOT expanded into a date: inventing a birthday to satisfy a
 * date box is exactly the kind of made-up detail this project refuses. That case
 * is reported instead.
 */
export function shapeFor(el, value, label = '') {
  const raw = String(value ?? '').trim();
  const type = (el.getAttribute('type') || '').toLowerCase();

  if (type === 'number' || el.getAttribute('inputmode') === 'numeric' || el.getAttribute('inputmode') === 'decimal') {
    // A UNIT changes the number's meaning. "4 weeks" typed into a box that
    // wants days is 4 days, and "120k" is not 120 — so an answer with a unit in
    // it is reported rather than stripped. A currency code is not a unit: Breezy's
    // salary box takes "140,000 CAD" as 140000.
    if (/\b(day|week|month|year|hour|lakh|lac|lpa|crore)s?\b|\d\s*k\b/i.test(raw)) {
      return { error: `this box only takes a number, and "${raw}" has a unit in it — put the number in yourself` };
    }
    const digits = raw.replace(/[^\d.]/g, '');
    if (!digits) return { error: `this box only takes a number, and "${raw}" has none` };
    return { value: digits };
  }

  if (type === 'date') {
    const day = parseDay(raw);
    if (day) return { value: `${day.y}-${day.m}-${day.d}` };
    return { error: `this box wants a full date (yyyy-mm-dd) and your answer is "${raw}"` };
  }

  // A TEXT box that says which date shape it wants: BambooHR's "Date Available"
  // is <input type=text placeholder="mm/dd/yyyy"> with a calendar button, and a
  // typed "1 November 2026" was thrown away. The same date, in its shape.
  const shape = dateShapeOf(`${el.getAttribute('placeholder') || ''} ${label}`);
  if (shape) {
    const day = parseDay(raw);
    if (!day) return { error: `this box wants a date (${shape}) and your answer is "${raw}"` };
    return { value: formatDay(day, shape) };
  }

  return { value: raw };
}

/** "mm/dd/yyyy", "dd.mm.yyyy", "yyyy-mm-dd" … when a box's words name one. */
export function dateShapeOf(words) {
  const m = /\b(mm|dd)([\/.\-])(dd|mm)\2(yyyy|yy)\b|\b(yyyy)([\/.\-])(mm)\6(dd)\b/i.exec(String(words || ''));
  return m ? m[0].toLowerCase() : null;
}

/**
 * A saved date with a DAY in it — "2026-11-01", "1 November 2026", "November 1,
 * 2026" — as its parts, read in local time. new Date(…).toISOString() turned
 * midnight on 1 November into 31 October anywhere east of Greenwich.
 * A month or a year alone is not a day, and gives nothing: never invented.
 */
export function parseDay(raw) {
  const s = String(raw || '').trim();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return { y: iso[1], m: pad(iso[2]), d: pad(iso[3]) };
  if (/^\d{4}(-\d{1,2})?$/.test(s) || !/\d/.test(s)) return null;
  // Words for the month and a separate day number: "1 November 2026".
  // "November 2026" has no day, and Date.parse would make it the 1st.
  if (!/[a-z]{3,}/i.test(s) || !/(^|\D)\d{1,2}(\D|$)/.test(s)) return null;
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return null;
  const t = new Date(parsed);
  return { y: String(t.getFullYear()), m: pad(t.getMonth() + 1), d: pad(t.getDate()) };
}

function formatDay({ y, m, d }, shape) {
  const sep = (/[\/.\-]/.exec(shape) || ['/'])[0];
  const yy = /yyyy/.test(shape) ? y : y.slice(2);
  if (/^yyyy/.test(shape)) return [y, m, d].join(sep);
  return (/^dd/.test(shape) ? [d, m, yy] : [m, d, yy]).join(sep);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A job or school date — stored "2021-03", or "2021" when the résumé gave only
 * a year — in the shape THIS box wants.
 *
 *   <input type=date>      2021-03-01. The day is the 1st: a date box cannot
 *                          hold a month alone, and the panel shows what went in.
 *   "MM/YYYY" placeholder  03/2021 (Workday's shape)
 *   a "Year" box           2021
 *   a "Month" box          March
 *
 * A year alone never becomes a full date — that would be inventing a month.
 */
export function shapeDate(el, value, label = '') {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(String(value || '').trim());
  if (!m) return { error: `no date saved for this` };
  const [, y, mo] = m;
  const words = `${label} ${el.getAttribute('placeholder') || ''}`;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'month') return mo ? { value: `${y}-${mo}` } : { error: `this box wants a month and your date is only "${y}"` };
  if (type === 'date') return mo ? { value: `${y}-${mo}-01` } : { error: `this box wants a full date and your date is only "${y}"` };
  if (/mm\s*\/\s*yyyy/i.test(words)) return mo ? { value: `${mo}/${y}` } : { error: `this box wants MM/YYYY and your date is only "${y}"` };
  if (/\byear\b/i.test(words) && !/\bmonth\b/i.test(words)) return { value: y };
  if (/\bmonth\b/i.test(words) && !/\byear\b/i.test(words)) return mo ? { value: MONTHS[Number(mo) - 1] } : { error: `no month saved, only "${y}"` };
  return { value: mo ? `${mo}/${y}` : y };
}

const DATE_KEYS = new Set(['eduStart', 'eduEnd', 'jobStart', 'jobEnd']);

/** A flatpickr date box: SmartRecruiters' From / To are <input data-input>. */
function isCalendarBox(el) {
  const root = el.getRootNode && el.getRootNode();
  return el.hasAttribute('data-input') && Boolean(root && root.querySelector && root.querySelector('.flatpickr-calendar, .flatpickr-input'))
    || /flatpickr-input/.test(el.className || '');
}

/**
 * A month and year picked from SmartRecruiters' calendar.
 *
 * Its From / To are flatpickr with the month-select plugin, and the whole
 * calendar lives inside the component's shadow root. Typed text is ignored
 * ("March 2021" + Enter picks today), so this does what a person does: opens
 * the calendar, steps the year with its arrows, and presses the month.
 * Measured on a live SmartRecruiters form, 19 September 2026.
 */
export async function setMonthYear(el, value) {
  const m = /^(\d{4})-(\d{2})/.exec(String(value || ''));
  if (!m) return { ok: false, reason: `this box wants a month and a year, and your date is only "${value}"` };
  const [, y, mo] = m;
  const root = el.getRootNode();
  el.focus?.();
  press(el);
  await sleep(400);
  const yearBox = root.querySelector('.cur-year');
  const prev = root.querySelector('.flatpickr-prev-month');
  const next = root.querySelector('.flatpickr-next-month');
  if (!yearBox || !prev || !next) return { ok: false, reason: 'the calendar did not open' };
  for (let i = 0; i < 80 && Number(yearBox.value) !== Number(y); i++) {
    press(Number(yearBox.value) > Number(y) ? prev : next);
    await sleep(60);
  }
  if (Number(yearBox.value) !== Number(y)) return { ok: false, reason: `the calendar would not go to ${y}` };
  const months = [...root.querySelectorAll('.flatpickr-monthSelect-month')];
  const cell = months.find((c) => (c.getAttribute('aria-label') || '').startsWith(`${MONTHS[Number(mo) - 1]} `)) || months[Number(mo) - 1];
  if (!cell) return { ok: false, reason: 'the calendar has no months to choose' };
  press(cell);
  await sleep(300);
  const ok = String(el.value || '').startsWith(`${y}-${mo}`) || new RegExp(`${MONTHS[Number(mo) - 1].slice(0, 3)}\\w*\\W+${y}`, 'i').test(el.value || '');
  return ok ? { ok: true, shown: `${MONTHS[Number(mo) - 1]} ${y}` } : { ok: false, reason: 'the calendar did not keep the month' };
}

/**
 * Types a value into a suggestion box and commits the TYPED text, for boxes
 * that take free text as well as suggestions: SmartRecruiters' job title,
 * company and school throw typed text away on blur, and keep it after the
 * keyboard's Down and Enter. Kept only if the box ends up holding exactly what
 * was typed — a different suggestion taken in its place is undone.
 */
export async function typedCommit(el, value) {
  const setter = nativeSetter(el);
  el.focus?.();
  if (setter) setter.call(el, value);
  else el.value = value;
  fire(el, ['input']);
  await sleep(700);
  for (const key of ['ArrowDown', 'Enter']) {
    const code = key === 'Enter' ? 13 : 40;
    el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode: code, which: code, bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode: code, which: code, bubbles: true, composed: true }));
    await sleep(200);
  }
  await sleep(300);
  const now = String(el.value || '').trim();
  if (now.toLowerCase() === String(value).trim().toLowerCase()) return { ok: true, shown: now };
  if (now) {
    if (setter) setter.call(el, '');
    fire(el, ['input']);
  }
  return { ok: false, reason: now ? `the box chose "${now}" instead, so it was cleared` : undefined };
}

/** Inside one of SmartRecruiters' <spl-autocomplete> components. */
function inSuggestionComponent(el) {
  return rootsOf(el).some((r) => r.host && /^SPL-AUTOCOMPLETE$/i.test(r.host.tagName));
}

/** Picks the suggestion that is the saved address: its house number and its city. */
function addressChooser(item, profile = {}) {
  const street = String(item.value).split(',')[0].trim().toLowerCase();
  const number = (street.match(/^\d+\w?/) || [''])[0];
  const name = street.replace(/^\d+\w?\s*/, '').split(/\s+/)[0] || '';
  const city = String(item.value).split(',')[1]?.trim().toLowerCase() || '';
  return (options) => options.find((o) => {
    const t = textOf(o).toLowerCase();
    return (!number || wordIn(t, number)) && (!name || t.includes(name)) && (!city || t.includes(city));
  }) || null;
}

/**
 * A combobox — a text box with a menu, which most vendors use for country,
 * location and every Yes/No question.
 *
 * Typing into it is not enough: the page only accepts a choice from its own
 * list, so the text has to be typed, the list given a moment to filter, and the
 * matching option clicked. If no option matches, the box is CLEARED rather than
 * left holding half-typed text that would fail the vendor's own validation.
 */
export async function setCombobox(el, value, { wait = 450, choose = null } = {}) {
  // Only an editable <input> can be typed into. A read-only one (Workable) or a
  // menu drawn as <div role="combobox"> (Rippling's Veteran Status) is opened
  // and picked from as it stands.
  const typable = el.tagName === 'INPUT' && !el.readOnly;
  const setter = typable ? nativeSetter(el) : null;
  const control = controlOf(el);
  const before = shownValue(el);
  const ownBefore = String(el.tagName === 'INPUT' ? el.value || '' : '').trim();

  // INTO VIEW FIRST. A press is acted out at the box's own coordinates, and a
  // box far below the fold is pressed at a point that is not on the screen —
  // Eightfold's Country, Salutation and work-authorisation menus never opened,
  // and every one of them was reported as "the page did not keep the value"
  // (20 Sep 2026). Scrolling is what a person does before pressing anything.
  const box = el.getBoundingClientRect?.();
  if (box && (box.top < 0 || box.bottom > (window.innerHeight || 0))) {
    el.scrollIntoView({ block: 'center' });
    await sleep(250);
  }
  // The menu opens on a MOUSE PRESS, not on typing. Measured on the live
  // Greenhouse form: setting the value and firing `input` alone left the menu
  // shut and matched nothing, while pressing the control first filtered the list
  // down to one option. react-select listens for mousedown, so the whole press
  // has to be acted out — pointerdown, mousedown, mouseup, click, button 0.
  press(control);
  await sleep(200);
  // Some menus open only on the box itself, or only from the keyboard:
  // Workable's is a READ-ONLY input that listens for a click or ArrowDown on
  // itself, and its list does not exist until it opens.
  //
  // Only while the box still says it is SHUT. Greenhouse's place picker opens
  // empty — its options arrive after typing — and pressing it a second time
  // because "no options yet" closed it again: every location failed.
  const shut = () => el.getAttribute('aria-expanded') !== 'true' && !optionsFor(el).length;
  if (shut()) {
    press(el);
    await sleep(200);
  }
  // THE BOX'S OWN WRAPPER. Eightfold listens for the press on the little group
  // around the input, not on the input and not on the outer block the search
  // above settles for — so its Country, Salutation and work-authorisation
  // menus never opened at all, and each was reported as a page that would not
  // keep the value. Measured 20 Sep 2026: pressing that wrapper opens them.
  if (shut() && el.parentElement && el.parentElement !== control) {
    press(el.parentElement);
    await sleep(250);
  }
  if (shut()) {
    el.focus?.();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
    await sleep(250);
  }

  const type = (text) => {
    el.focus?.();
    if (setter) setter.call(el, text);
    else el.value = text;
    fire(el, ['input']);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
  };

  // Searches are typed the way a person types them: the whole answer first,
  // then narrower, then the other wordings for the same answer, then nothing at
  // all — because typing filters the list, and a filter that matches no option
  // hides the very option that answers the question.
  //
  // Greenhouse's gender box offers Male / Female / Non-binary / "I don't wish to
  // answer". Typing a saved "Prefer not to say" filtered all four away and the
  // box was reported as a failure. The empty attempt is the fix: open the menu,
  // look at every option, and match on meaning.
  // A read-only box cannot be typed into: the open list is all there is, so it
  // is read as it stands.
  const attempts = !typable ? [''] : [
    value,
    value.split(',')[0].trim(),
    ...choiceWords(value).filter((w) => w && w !== value.toLowerCase()).slice(0, 8),
    '',
  ].filter((v, i, all) => all.indexOf(v) === i);

  // A LIMIT ON ONE MENU. Eightfold's questions are searches that each answer
  // over the network; trying every spelling of every one of them kept the panel
  // saying "Reading the form…" for over two minutes. After six seconds on a
  // single menu the remaining spellings are given up, and the last attempt
  // ('' — read the whole list and match on meaning) is still made.
  const begun = Date.now();
  for (const attempt of attempts) {
    if (Date.now() - begun > 6000 && attempt !== attempts[attempts.length - 1]) continue;
    if (typable) type(attempt);
    // Suggestions that come from a lookup arrive when the network says so:
    // Greenhouse's "Location (City)" filled on one run and failed on the next
    // with the same answer, on a fixed 450 ms wait. So the list is watched for
    // up to ~2 s, and read the moment a matching option appears.
    // It stops as soon as the list is on screen and has stopped changing: a
    // settled list with no match will not grow one, and waiting the full time
    // on every one of a menu's spellings made a form take a minute.
    let pick = null;
    let last = '';
    let steady = 0;
    for (let waited = 0; waited < (attempt ? wait * 4 : 300); waited += 150) {
      await sleep(150);
      pick = choose ? choose(optionsFor(el)) : bestOption(el, attempt || value, value);
      if (pick) break;
      const now = optionsFor(el).map(textOf).join('|');
      steady = now && now === last ? steady + 1 : 0;
      last = now;
      if (steady >= 2) break;
    }
    if (pick) {
      const chosen = textOf(pick);
      press(pick);
      await sleep(250);
      // Some menus listen on the option's INSIDE, not on the option element:
      // SmartRecruiters' <spl-select-option> ignored a press on itself. If the
      // box has not moved off what was typed, press the option's first child.
      const stillTyped = () => el.tagName === 'INPUT' && String(el.value || '').trim() === String(attempt || '').trim() && attempt;
      if (stillTyped() && pick.firstElementChild) {
        press(pick.firstElementChild);
        await sleep(300);
      }
      // The choice does NOT come back as el.value — react-select empties its
      // input and renders the selection beside it — so the proof is the text the
      // control now shows. A read-only box (Workable) shows it as its own value.
      // Rippling writes the choice into the input itself ("Choose not to
      // disclose"), which the control's text does not include — so a value that
      // equals the option just picked is proof too.
      const own = String(el.tagName === 'INPUT' ? el.value || '' : el.textContent || '').replace(/\s+/g, ' ').trim();
      // Oracle's phone-code box shows "+44" for the option "+44 (United
      // Kingdom)": part of the option is proof too, as long as it changed.
      const lowOwn = own.toLowerCase();
      const lowChosen = chosen.toLowerCase();
      const sameAsChosen = lowOwn && (lowOwn === lowChosen || lowChosen.startsWith(lowOwn) || lowOwn.startsWith(lowChosen));
      // The box's own value first: Oracle's surrounding control holds fixed
      // text that never changes, and reading it first hid the "+44" in the box.
      // What was just TYPED is never proof of a choice: SmartRecruiters' city box
      // held the typed "London", which is also the start of the option, and a
      // failed pick was reported as a success.
      // But a box holding the WHOLE option, with its list now shut, did take
      // it: Ashby's "In which state do you permanently reside?" shows exactly
      // "California" whether typed or chosen, and closes only on a choice.
      const closedOnIt = lowOwn === lowChosen && el.getAttribute('aria-expanded') === 'false';
      const typedOnly = typable && own === String(attempt || '').trim() && !closedOnIt;
      const now = (sameAsChosen && own !== ownBefore && !typedOnly) || (!typable && own) ? own : shownValue(el);
      // A menu that already showed this answer (BambooHR's Country, set to
      // "United States" before we came) has not changed, and is still right.
      if (now && (now !== before || (!typable && now.toLowerCase() === lowChosen))) return { ok: true, shown: now, chosen };
      // LAST, THE LIST ITSELF. Eightfold keeps its list open and leaves the
      // typed words in the box after a choice, so none of the tests above saw
      // one and every one of its menus was cleared again as a failure. The
      // option it now marks aria-selected="true" is the one just pressed.
      const markedChosen = optionsFor(el).some((o) => o.getAttribute('aria-selected') === 'true'
        && textOf(o).replace(/\s+/g, ' ').trim().toLowerCase() === lowChosen);
      if (markedChosen) return { ok: true, shown: chosen, chosen };
    }
  }
  // What the menu offered, so the panel can say "matches none of: …" instead of
  // blaming the page. Workable's "Work Authorization" is a list of Singapore
  // visa types, and a saved "Yes" is simply not one of them.
  if (typable) type('');
  await sleep(200);
  const offered = optionsFor(el).map(textOf).filter(Boolean);

  // Nothing matched: leave it empty rather than holding half-typed text that
  // would fail the vendor's own validation, or worse, be submitted as an answer.
  if (typable) type('');
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return {
    ok: false,
    shown: '',
    reason: offered.length
      ? `your answer "${value}" matches none of the options (${offered.slice(0, 6).join(', ')}${offered.length > 6 ? ', …' : ''})`
      : undefined,
  };
}

/**
 * The clickable shell of a combobox: what a person presses to open it, and
 * where the chosen answer is rendered.
 *
 * It must be the OUTER control, not the inner input container. react-select
 * nests `.select__control > .select__value-container > .select__input-container`,
 * and the choice appears in the value container as a sibling of the input. The
 * first version of this stopped at `select__input-container`, so a committed
 * choice — "Toronto, Ontario, Canada", visible on screen — read back as empty
 * and was reported to the person as a failure.
 */
function controlOf(el) {
  let fallback = null;
  let node = el.parentElement;
  for (let hops = 0; node && hops < 5; hops++, node = node.parentElement) {
    const cls = typeof node.className === 'string' ? node.className : '';
    if (/(^|[\s_-])control($|[\s_-])|__control/i.test(cls)) return node;
    if (!fallback && /container|wrapper|field/i.test(cls)) fallback = node;
  }
  return fallback || el.parentElement || el;
}


/** A box that is really a menu: a listbox nearby, or a pop-up it controls. */
function looksLikeMenu(el) {
  if (el.getAttribute('aria-haspopup') || el.getAttribute('aria-controls') || el.getAttribute('aria-expanded')) return true;
  if (el.readOnly) return true;
  const near = el.closest('[class*="select"], [class*="dropdown"], [class*="combobox"]');
  if (near && near.querySelector('[role="listbox"], [role="option"], ul, ol')) return true;
  return false;
}

/**
 * The whole press, because react-select acts on mousedown and ignores click.
 *
 * The pointer half must be REAL PointerEvents, aimed at the element's middle.
 * BambooHR's State and Country menus (a hidden <select> behind a button) stayed
 * shut for a MouseEvent named "pointerdown" and opened for a PointerEvent with
 * pointerType "mouse" — measured on a live BambooHR form, 19 September 2026.
 */
function press(node) {
  if (!node) return;
  const r = node.getBoundingClientRect ? node.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
  const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1, ...at };
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  node.dispatchEvent(new Pointer('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }));
  node.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
  node.dispatchEvent(new Pointer('pointerup', { ...base, buttons: 0, pointerType: 'mouse', isPrimary: true }));
  node.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  node.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
}

/**
 * What the widget is currently showing as its answer.
 *
 * react-select renders the choice in a sibling element, not in the input, so
 * this reads the control's own text and ignores the placeholder. Without it a
 * committed choice reads back as an empty field and gets reported as a failure —
 * which is exactly what happened on the first live run.
 */
export function shownValue(el) {
  const control = controlOf(el);
  if (!control) return '';
  const picked = control.querySelector('[class*="singleValue"], .select__single-value, [class*="multiValue"]');
  const text = (picked ? picked.textContent : control.innerText || '').trim();
  if (!text || /^select\.\.\.$|^choose|^select an option$/i.test(text)) return '';
  return text;
}

/**
 * The options belonging to THIS box.
 *
 * Scoping is not tidiness, it is correctness. On the live Greenhouse form the
 * phone widget (intl-tel-input) keeps its own list of 244 countries in the
 * document at all times, so a page-wide search for `[role=option]` while filling
 * the COUNTRY box returned the phone widget's menu and picked from it. Each
 * option here must be traceable to the element being filled: by `aria-controls`,
 * by react-select's `react-select-{id}-option-*` ids, or by sharing a wrapper.
 */
/**
 * An option's words. SmartRecruiters puts role="option" inside each
 * <spl-dropdown-item>'s shadow root and the words in the item itself, so the
 * option's own text is empty and its host's is the answer.
 */
function textOf(o) {
  const own = (o.textContent || '').replace(/\s+/g, ' ').trim();
  if (own) return own;
  const host = o.getRootNode && o.getRootNode().host;
  return host ? (host.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

/** A menu's options, including ones inside its items' own shadow roots. */
function deepOptions(menu) {
  const found = [...menu.querySelectorAll(OPTION)];
  if (found.length) return found;
  const inner = [];
  for (const e of menu.querySelectorAll('*')) if (e.shadowRoot) inner.push(...e.shadowRoot.querySelectorAll('[role="option"]'));
  if (inner.length) return inner;
  // Last: the menu's own children. SmartRecruiters' city suggestions are
  // <spl-select-option> elements with no role at all, straight inside the
  // role="listbox" the box points at — which is what makes them its options.
  if (menu.getAttribute('role') === 'listbox') {
    return [...menu.children].filter((c) => (c.textContent || '').trim());
  }
  return [];
}

// Oracle draws its menus as a grid: role="gridcell", not role="option";
// BambooHR as a role="menu" of role="menuitem".
const OPTION = '[role="option"], [role="gridcell"], [role="menuitem"], li, .select__option';

function optionsFor(el) {
  const listed = [];
  // SmartRecruiters' menus live inside shadow roots — sometimes the input's
  // own, sometimes the component around it — where document.getElementById
  // cannot reach. Every root from the input outwards is searched.
  const roots = rootsOf(el);
  const root = roots[0];
  const byId = (id) => roots.map((r) => (r.getElementById ? r.getElementById(id) : null)).find(Boolean) || null;
  // BambooHR's menu button names its menu only in data-menu-id="fab-menu113".
  const controls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || el.getAttribute('data-menu-id');
  if (controls) {
    const menu = byId(controls);
    if (menu) listed.push(...deepOptions(menu));
  }
  if (!listed.length && el.id) {
    listed.push(...root.querySelectorAll(`[id^="react-select-${cssEscapeId(el.id)}-option"]`));
  }
  if (!listed.length) {
    const wrapper = el.closest('[class*="select"], [class*="combobox"], [class*="autocomplete"]') || el.parentElement;
    if (wrapper) listed.push(...wrapper.querySelectorAll('[role="option"], [role="gridcell"], .select__option, li[id*="option"]'));
  }
  const shown = listed.filter((o) => o.getClientRects().length > 0);
  if (shown.length) return shown;
  // LAST RESORT: a menu drawn elsewhere in the page. Rippling renders its list
  // in a layer at the end of <body>, tied to the box by nothing at all. It is
  // accepted only while THIS box says it is open and exactly one list is on
  // screen — the intl-tel-input lesson above is why it is not simply "any
  // visible option".
  if (el.getAttribute('aria-expanded') === 'true') {
    const lists = roots.flatMap((r) => [...r.querySelectorAll('[role="listbox"]')]).filter((l) => l.getClientRects().length > 0);
    if (lists.length === 1) return [...lists[0].querySelectorAll('[role="option"]')].filter((o) => o.getClientRects().length > 0);
  }
  return [];
}

/** The shadow roots around a node, innermost first, ending with the document. */
function rootsOf(el) {
  const out = [];
  let node = el;
  while (node && node.getRootNode) {
    const r = node.getRootNode();
    out.push(r);
    if (!r.host) break;
    node = r.host;
  }
  if (!out.includes(document)) out.push(document);
  return out;
}

/** All the text on the page, including inside web components. */
function deepText(root = document) {
  let text = root === document ? document.body.innerText : root.textContent || '';
  for (const e of root.querySelectorAll('*')) if (e.shadowRoot && e.id !== 'unsaturated-panel') text += ' ' + deepText(e.shadowRoot);
  return text;
}

/** `needle` as whole words inside `hay`: "india" is in "india (+91)", not in "indian". */
function wordIn(hay, needle) {
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, 'i').test(hay);
}

function cssEscapeId(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/** The option that best answers what was asked, or nothing. */
function bestOption(el, typed, wanted) {
  const options = optionsFor(el);
  if (!options.length) return null;
  // "I don't wish to answer" and "I don’t wish to answer" are the same words;
  // forms use both apostrophes and a saved answer will only ever have one.
  const flat = (v) => String(v).replace(/[‘’ʼ]/g, "'").trim().toLowerCase();
  const text = (o) => flat(textOf(o));
  const want = flat(wanted);
  const head = flat(typed);
  // A saved "Prefer not to say" has to find "I don't wish to answer" on
  // Greenhouse and "Decline to self identify" elsewhere; a saved "Yes" has to
  // find "Yes, I am authorised to work". choiceWords holds those wordings.
  const spellings = choiceWords(wanted).filter(Boolean).map(flat);

  return (
    options.find((o) => text(o) === want)
    || options.find((o) => text(o) === head)
    || options.find((o) => spellings.some((w) => text(o) === w))
    || options.find((o) => text(o).startsWith(head))
    || spellings.filter((w) => w.length >= 2).map((w) => options.find((o) => text(o).startsWith(w))).find(Boolean)
    // WHOLE WORDS from here on. A plain "contains" let "India" pick "British
    // Indian Ocean Territory", which sorts first in every country list.
    || options.find((o) => wordIn(text(o), head))
    // The option sharing the most words with the answer, before any single
    // shared word: BambooHR lists "College - Bachelor of Arts" above "College -
    // Bachelor of Science", and "bachelor" alone picked Arts for a BSc.
    || byOverlap(options.map(textOf), want, options)
    // Spellings in THEIR order, most specific first ("bachelor of science"
    // before "bachelor"), not the menu's.
    || spellings.filter((w) => w.length > 3 || /^\+\d/.test(w)).map((w) => options.find((o) => wordIn(text(o), w))).find(Boolean)
    // Last, the same yes / no / decline in other words — only when exactly one
    // option means it (see answers.pickOption).
    || options[bandFor(options.map(textOf), wanted)]
    || byMeaning(options.map(textOf), wanted, options)
    || null
  );
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'you', 'are', 'not', 'have', 'this', 'that', 'degree', 'college']);

/** The one option sharing the most (and at least two) words with the answer. */
export function byOverlap(texts, wanted, items) {
  const words = (s) => new Set(String(s).toLowerCase().replace(/[‘’']/g, '').split(/[^a-z0-9+]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
  const want = words(wanted);
  if (want.size < 2) return null;
  const scores = texts.map((t) => [...words(t)].filter((w) => want.has(w)).length);
  const best = Math.max(0, ...scores);
  if (best < 2 || scores.filter((s) => s === best).length !== 1) return null;
  return items[scores.indexOf(best)];
}

function byMeaning(texts, wanted, items) {
  const m = meaningOf(wanted);
  if (!m) return null;
  const same = texts.map((t, i) => (meaningOf(t) === m ? i : -1)).filter((i) => i >= 0);
  return same.length === 1 ? items[same[0]] : null;
}

/**
 * Attaching the résumé.
 *
 * `<input type=file>` declares `attribute FileList? files` in the HTML standard
 * — not readonly — so a FileList built from a DataTransfer can be assigned. That
 * is the only supported way to attach a file without the person picking it, and
 * it works because the extension runs in their own browser with their own file.
 *
 * The input is usually invisible (Greenhouse hides it behind a drop zone with
 * `class="visually-hidden"`), so this never clicks it; it assigns and fires
 * `change`, which is what the drop zone's own handler listens for.
 */
export function attachFile(el, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  fire(el, ['input', 'change']);
  if (el.files.length === 1 && el.files[0].name === file.name) return true;
  // Greenhouse REPLACES the input element once it has taken the file, so the
  // reference we hold can report zero files on a form that accepted it happily.
  // The page showing the filename is the honest test of whether it landed.
  // Inside a web component the file name is drawn in a shadow root, which
  // document.body.innerText does not include.
  return deepText().includes(file.name);
}

/** Radios and checkboxes, chosen by their visible words rather than by value. */
export function chooseRadio(group, wanted) {
  const want = String(wanted).trim().toLowerCase();
  for (const el of group) {
    const text = (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.value || '').trim().toLowerCase();
    if (text === want) {
      el.click();
      return el.checked;
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What is in a box now, as the person would read it: the typed text, the
 * chosen option's words, or what a custom dropdown shows. Used by "remember
 * what I typed", which must save the ANSWER ("No"), never an option's value
 * attribute ("opt_2").
 */
export function currentAnswer(el) {
  if (!el) return '';
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const o = el.selectedOptions && el.selectedOptions[0];
    const text = o ? o.textContent.trim() : '';
    return !text || /^(select|choose|please select|--)/i.test(text) || !o.value ? '' : text;
  }
  if (el.type === 'radio' || el.type === 'checkbox') return '';
  if (tag !== 'input' && tag !== 'textarea') {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return /^(select|choose|please select|--)/i.test(text) ? '' : text;
  }
  if (el.type === 'file' || el.type === 'password' || el.type === 'hidden') return '';
  const shown = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') ? shownValue(el) : '';
  return String(shown || el.value || '').trim();
}

/**
 * Runs a plan from matcher.planFill and reports what actually landed.
 *
 * Every fill is READ BACK from the page afterwards. The panel may only say a
 * field is done when the value is visible in the element — a report of success
 * that nobody verified is how autofill tools quietly send half-empty forms.
 */
export async function applyPlan(plan, { resumeFile, coverLetterFile } = {}) {
  const done = [];
  const failed = [];

  for (const item of plan.fills) {
    const el = item.field.el;
    try {
      let ok;
      if (item.button) {
        // Ashby's Yes / No: press the button, and believe it only when the page
        // marks it pressed (or, for Yes, ticks the hidden box behind it).
        press(item.button);
        await sleep(200);
        ok = item.button.getAttribute('aria-pressed') === 'true' || (/^yes$/i.test(item.button.textContent.trim()) && el.checked === true);
        if (ok) item.committed = item.button.textContent.trim();
      } else if (item.choice) {
        // A radio or checkbox the plan already chose: click it the way a person
        // would, then read the box back rather than trusting the click.
        press(el);
        const ticked = () => el.checked === true || el.getAttribute('aria-checked') === 'true';
        if (!ticked() && el.tagName === 'INPUT') el.click();
        await sleep(150);
        ok = ticked();
        if (ok) item.committed = item.key === 'currentJob' ? 'ticked' : (item.field.label || el.value || '').split('|').pop().trim().slice(0, 60);
      } else if (item.key === 'resume' || item.key === 'coverLetter') {
        const file = item.key === 'resume' ? resumeFile : coverLetterFile;
        if (!file) {
          failed.push({ ...item, reason: `no ${item.key === 'resume' ? 'résumé' : 'cover letter'} file available` });
          continue;
        }
        ok = attachFile(el, file);
      } else if (item.field.role === 'combobox' || el.tagName.toLowerCase() === 'select') {
        if (el.tagName.toLowerCase() === 'select') {
          const button = menuButtonFor(el);
          let picked = button && el.options.length <= 2 ? { ok: false } : setSelect(el, item.value);
          if (!picked.ok && item.alt && [...el.options].some((o) => /hispanic|latin/i.test(o.textContent))) {
            const second = setSelect(el, item.alt);
            if (second.ok) picked = second;
          }
          // BambooHR's State / Country / Education: the <select> is a hidden
          // stand-in holding one option until its button's menu is opened, so
          // the answer is picked from that menu instead.
          if (!picked.ok && button) {
            const viaMenu = await setCombobox(button, item.value);
            picked = viaMenu.ok ? { ok: true, shown: viaMenu.shown } : { ok: false, reason: viaMenu.reason || picked.reason };
          }
          ok = picked.ok;
          if (ok) item.committed = picked.shown;
          else item.reasonOverride = picked.reason;
        } else if (item.lookup) {
          // The street address in a place search: the whole address first, then
          // street and city, and only a suggestion with the same house number,
          // street and city is picked — never "the first thing in the list".
          let picked = await setCombobox(el, item.value, { choose: addressChooser(item) });
          if (!picked.ok && item.fallback) picked = await setCombobox(el, item.fallback, { choose: addressChooser({ value: item.fallback }) });
          ok = picked.ok;
          if (ok) item.committed = picked.shown;
          else item.reasonOverride = 'none of the address suggestions was your address — pick it from the list yourself';
        } else {
          let picked = await setCombobox(el, item.value);
          // A suggestion box that also takes free text (SmartRecruiters' title,
          // company, school): no suggestion was the answer, so the typed words
          // are committed the way the keyboard does it.
          if (!picked.ok && inSuggestionComponent(el)) {
            const typed = await typedCommit(el, item.value);
            picked = typed.ok ? typed : { ...picked, reason: typed.reason || picked.reason };
          }
          // An "ethnicity" menu that turns out to be the Hispanic-or-Latino
          // question: answered from that saved answer instead.
          if (!picked.ok && item.alt && /hispanic|latin/i.test(picked.reason || '')) {
            const second = await setCombobox(el, item.alt);
            if (second.ok) picked = second;
          }
          // Menus filled one straight after another (Greenhouse's gender,
          // Hispanic/Latino, race, veteran) sometimes drop one — a matter of
          // timing, not of the answer. One more try after a pause.
          if (!picked.ok && !picked.reason) {
            await sleep(500);
            picked = await setCombobox(el, item.value, { wait: 700 });
          }
          ok = picked.ok;
          // What the widget committed, which may be worded differently from the
          // profile: "Toronto" can commit as "Toronto, Ontario, Canada".
          if (ok) item.committed = picked.shown;
          else if (picked.reason) item.reasonOverride = picked.reason;
        }
      } else if (item.key === 'location' || item.key === 'city') {
        // Place boxes are often an autocomplete WITHOUT role="combobox" (Lever).
        // Try to pick a real suggestion; fall back to plain text, narrower first.
        const picked = await setCombobox(el, item.value);
        if (picked.ok) {
          ok = true;
          item.committed = picked.shown;
        } else {
          ok = setValue(el, item.fallback || item.value);
          if (ok) item.committed = el.value;
        }
      } else if (DATE_KEYS.has(item.key) && isCalendarBox(el)) {
        const picked = await setMonthYear(el, item.value);
        ok = picked.ok;
        if (ok) item.committed = picked.shown;
        else item.reasonOverride = picked.reason;
      } else if (DATE_KEYS.has(item.key)) {
        const shaped = shapeDate(el, item.value, item.field.label);
        if (shaped.error) {
          failed.push({ ...item, reason: shaped.error });
          continue;
        }
        ok = setValue(el, shaped.value);
        if (ok) item.committed = shaped.value;
      } else {
        const shaped = shapeFor(el, item.value, item.field.label);
        if (shaped.error) {
          failed.push({ ...item, reason: shaped.error });
          continue;
        }
        ok = setValue(el, shaped.value);
        // A text box that refuses a typed value is often a dropdown in
        // disguise: Workable renders its work-authorisation question as a
        // styled input with a listbox beside it, and no role="combobox".
        // Never a phone box: intl-tel-input marks the number box aria-controls,
        // and "working it as a menu" typed and then CLEARED a good number.
        if (!ok && looksLikeMenu(el) && item.key !== 'phone') {
          const picked = await setCombobox(el, shaped.value);
          ok = picked.ok;
          if (ok) item.committed = picked.shown;
          else if (picked.reason) item.reasonOverride = picked.reason;
        }
        if (ok && !item.committed && shaped.value !== item.value) item.committed = shaped.value;
      }
      // A password is never shown back, not even on the person's own panel.
      if (ok && (item.key === 'password' || item.key === 'passwordConfirm')) item.committed = '••••••••';
      (ok ? done : failed).push(ok ? item : { ...item, reason: item.reasonOverride ?? 'the page did not keep the value' });
    } catch (err) {
      failed.push({ ...item, reason: String(err && err.message ? err.message : err) });
    }
  }
  // A number the page emptied afterwards is typed again: changing a phone
  // widget's country (the menu beside it) can clear the number beside it.
  for (const item of done) {
    const el = item.field.el;
    if (item.key === 'phone' && el && el.isConnected && el.tagName === 'INPUT' && !el.value) setValue(el, item.value);
  }
  return { done, failed, skipped: plan.skipped };
}

/**
 * The button a hidden <select> stands in for. BambooHR renders
 * `<select aria-hidden tabindex=-1 style="opacity:0;height:0">` beside
 * `<button aria-haspopup data-menu-id="fab-menu113">`; the person uses the
 * button, and the select only records the result.
 */
export function menuButtonFor(select) {
  const hidden = select.getAttribute('aria-hidden') === 'true' || select.getAttribute('tabindex') === '-1'
    || getComputedStyle(select).opacity === '0' || !select.getClientRects().length;
  if (!hidden) return null;
  const wrap = select.closest('[data-fabric-component="Select"]') || select.parentElement;
  const button = wrap && wrap.querySelector('button[aria-haspopup], [role="combobox"]');
  return button && button !== select ? button : null;
}

function setSelect(el, value) {
  const flat = (v) => String(v ?? '').replace(/[‘’ʼ]/g, "'").trim().toLowerCase();
  const want = flat(value);
  const text = (o) => flat(o.textContent);
  const yes = /^(yes|y|true)$/.test(want);
  const no = /^(no|n|false)$/.test(want);

  const spellings = choiceWords(value).filter(Boolean).map(flat);
  const option = [...el.options].find((o) => text(o) === want || String(o.value).toLowerCase() === want)
    || [...el.options].find((o) => text(o).startsWith(want))
    || [...el.options].find((o) => spellings.some((w) => text(o) === w))
    || spellings.filter((w) => w.length > 3).map((w) => [...el.options].find((o) => text(o).startsWith(w))).find(Boolean)
    || byOverlap([...el.options].map((o) => o.textContent), value, [...el.options])
    || spellings.filter((w) => w.length > 3 || /^\+\d/.test(w)).map((w) => [...el.options].find((o) => wordIn(text(o), w))).find(Boolean)
    // "Yes, I am authorised to work" answers a saved "Yes"; "No - I do not
    // require sponsorship" answers a saved "No". Anchored at the start so
    // "Not sure" never counts as "No".
    || (yes ? [...el.options].find((o) => /^yes\b/.test(text(o))) : null)
    || (no ? [...el.options].find((o) => /^no\b/.test(text(o))) : null)
    || [...el.options][bandFor([...el.options].map((o) => o.textContent), value)]
    || byMeaning([...el.options].map((o) => o.textContent), value, [...el.options]);

  if (!option) {
    // Personio asks language level as A1…C2; a saved sentence matches none of
    // them. Saying so is the honest answer — "the page did not keep the value"
    // blamed the page for a question only the person can answer.
    const choices = [...el.options].map((o) => o.textContent.trim()).filter(Boolean).slice(0, 6).join(', ');
    return { ok: false, reason: `your answer "${value}" matches none of the options (${choices})` };
  }
  el.value = option.value;
  fire(el);
  return { ok: el.value === option.value, reason: 'the page did not keep the choice', shown: option.textContent.trim() };
}
