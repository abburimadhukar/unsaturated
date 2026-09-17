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

const nativeSetter = (el) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value')?.set;
};

function fire(el, types = ['input', 'change']) {
  for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true }));
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
  if (el.type === 'tel' || /phone|tel/i.test(`${el.id} ${el.name}`)) {
    const a = digits(now);
    const b = digits(value);
    return a === b || a.endsWith(b) || b.endsWith(a);
  }
  // Some widgets trim or collapse whitespace; anything else is a real mismatch.
  return now.trim() === value.trim();
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
export async function setCombobox(el, value, { wait = 450 } = {}) {
  const setter = nativeSetter(el);
  const control = controlOf(el);
  const before = shownValue(el);

  // The menu opens on a MOUSE PRESS, not on typing. Measured on the live
  // Greenhouse form: setting the value and firing `input` alone left the menu
  // shut and matched nothing, while pressing the control first filtered the list
  // down to one option. react-select listens for mousedown, so the whole press
  // has to be acted out — pointerdown, mousedown, mouseup, click, button 0.
  press(control);
  await sleep(200);

  const type = (text) => {
    el.focus?.();
    if (setter) setter.call(el, text);
    else el.value = text;
    fire(el, ['input']);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  };

  // Searches are typed the way a person types them: the whole answer first,
  // then narrower. Greenhouse's location box wants a place it recognises, and
  // "Toronto, Ontario, Canada" finds nothing while "Toronto" offers
  // "Toronto, ON, Canada" — so the first word of the answer is the second try.
  const attempts = [value, value.split(',')[0].trim()].filter((v, i, all) => v && all.indexOf(v) === i);

  for (const attempt of attempts) {
    type(attempt);
    await sleep(wait);
    const pick = bestOption(el, attempt, value);
    if (pick) {
      const chosen = pick.textContent.trim();
      press(pick);
      await sleep(250);
      // The choice does NOT come back as el.value — react-select empties its
      // input and renders the selection beside it — so the proof is the text the
      // control now shows.
      const now = shownValue(el);
      if (now && now !== before) return { ok: true, shown: now, chosen };
    }
  }

  // Nothing matched: leave it empty rather than holding half-typed text that
  // would fail the vendor's own validation, or worse, be submitted as an answer.
  type('');
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { ok: false, shown: '' };
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

/** The whole press, because react-select acts on mousedown and ignores click. */
function press(node) {
  if (!node) return;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 }));
  }
}

/**
 * What the widget is currently showing as its answer.
 *
 * react-select renders the choice in a sibling element, not in the input, so
 * this reads the control's own text and ignores the placeholder. Without it a
 * committed choice reads back as an empty field and gets reported as a failure —
 * which is exactly what happened on the first live run.
 */
function shownValue(el) {
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
function optionsFor(el) {
  const listed = [];
  const controls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  if (controls) {
    const menu = document.getElementById(controls);
    if (menu) listed.push(...menu.querySelectorAll('[role="option"], li, .select__option'));
  }
  if (!listed.length && el.id) {
    listed.push(...document.querySelectorAll(`[id^="react-select-${cssEscapeId(el.id)}-option"]`));
  }
  if (!listed.length) {
    const wrapper = el.closest('[class*="select"], [class*="combobox"], [class*="autocomplete"]') || el.parentElement;
    if (wrapper) listed.push(...wrapper.querySelectorAll('[role="option"], .select__option, li[id*="option"]'));
  }
  return listed.filter((o) => o.getClientRects().length > 0);
}

function cssEscapeId(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/** The option that best answers what was asked, or nothing. */
function bestOption(el, typed, wanted) {
  const options = optionsFor(el);
  if (!options.length) return null;
  const text = (o) => o.textContent.trim().toLowerCase();
  const want = wanted.trim().toLowerCase();
  const head = typed.trim().toLowerCase();
  return (
    options.find((o) => text(o) === want)
    || options.find((o) => text(o) === head)
    || options.find((o) => text(o).startsWith(head))
    || options.find((o) => text(o).includes(head))
    || null
  );
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
  return document.body.innerText.includes(file.name);
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
 * Runs a plan from matcher.planFill and reports what actually landed.
 *
 * Every fill is READ BACK from the page afterwards. The panel may only say a
 * field is done when the value is visible in the element — a report of success
 * that nobody verified is how autofill tools quietly send half-empty forms.
 */
export async function applyPlan(plan, { resumeFile } = {}) {
  const done = [];
  const failed = [];

  for (const item of plan.fills) {
    const el = item.field.el;
    try {
      let ok;
      if (item.key === 'resume') {
        ok = resumeFile ? attachFile(el, resumeFile) : false;
        if (!resumeFile) {
          failed.push({ ...item, reason: 'no résumé file available' });
          continue;
        }
      } else if (item.field.role === 'combobox' || el.tagName.toLowerCase() === 'select') {
        if (el.tagName.toLowerCase() === 'select') {
          ok = setSelect(el, item.value);
        } else {
          const picked = await setCombobox(el, item.value);
          ok = picked.ok;
          // What the widget committed, which may be worded differently from the
          // profile: "Toronto" can commit as "Toronto, Ontario, Canada".
          if (ok) item.committed = picked.shown;
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
      } else {
        ok = setValue(el, item.value);
      }
      (ok ? done : failed).push(ok ? item : { ...item, reason: 'the page did not keep the value' });
    } catch (err) {
      failed.push({ ...item, reason: String(err && err.message ? err.message : err) });
    }
  }
  return { done, failed, skipped: plan.skipped };
}

function setSelect(el, value) {
  const want = String(value).trim().toLowerCase();
  const option = [...el.options].find(
    (o) => o.textContent.trim().toLowerCase() === want || String(o.value).toLowerCase() === want,
  );
  if (!option) return false;
  el.value = option.value;
  fire(el);
  return el.value === option.value;
}
