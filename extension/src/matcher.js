/**
 * Deciding what a box on an employer's form is asking for.
 *
 * This is the whole difficulty of autofill. Employers do not share a vocabulary,
 * and the same question arrives with a different id, a different name and
 * different words on every vendor. Surveyed live on 17 September 2026
 * (scripts/ats-survey.mjs), one field — the person's phone number — appears as:
 *
 *   greenhouse   <input id="phone" type="tel">                label "Phone*"
 *   lever        <input name="phone">                          label "Phone"
 *   ashby        <input id="de1e6cbb-299d-…" type="tel">       label "Phone"
 *   workable     <input name="phone" type="tel">               label "* Phone +1"
 *   recruitee    <input name="candidate.phone" type="tel">     label "Phone number *"
 *   rippling     <input id="field-35" name="FlKLEygNhmU">      label "Phone number"
 *   bamboohr     <input id="phone" name="phone">               label "Phone *"
 *
 * Rippling is the case that decides the design: its ids are positional
 * (`field-35`) and its names are random tokens, so ONLY the visible label
 * identifies the field. Ashby is the mirror image: custom questions are UUIDs
 * with a readable label. Nothing can rely on ids alone, and nothing can rely on
 * labels alone — so each rule carries several signals and the strongest wins.
 *
 * Pure on purpose: it reads elements and returns a plan. Nothing here writes to
 * a page, which is what lets the whole matcher be tested against saved copies of
 * real forms in tests/extension-matcher.test.ts.
 */

/** The facts we are willing to fill without anyone approving them per job. */
export const FACT_KEYS = [
  'firstName', 'lastName', 'fullName', 'preferredName', 'email', 'phone',
  'address', 'city', 'region', 'postcode', 'country', 'location',
  'linkedin', 'github', 'website', 'currentCompany', 'currentTitle', 'resume',
];

/**
 * Questions this never answers by itself, whatever the profile holds.
 *
 * Three kinds, and they are refused for three different reasons.
 *
 * SENSITIVE — gender, ethnicity, disability, veteran status, pronouns. Special
 * category data under GDPR Article 9; answering it from a stored preference is
 * a decision the person makes on the day, on the page, or not at all. Ashby's
 * form renders these as radios labelled just "Man" / "Woman", which is also why
 * a label matcher must never be allowed to guess near them.
 *
 * ATTESTATION — work authorisation, sponsorship, notice period, criminal
 * record. A wrong answer here is a lie told in the person's name. These are
 * answered from the approved answer library, per application, not by this.
 *
 * MONEY — salary expectations. Always the person's call.
 */
export const NEVER_FILL = [
  { kind: 'sensitive', re: /\b(gender|sex|pronouns?|race|ethnic\w*|hispanic|latino|veteran|disab\w*|lgbt\w*|orientation|religio\w*|marital|date of birth|d\.?o\.?b\.?)\b/i },
  { kind: 'attestation', re: /\b(authorized|authorisation|authorization|eligible to work|right to work|sponsor|visa|work permit|citizen|security clearance|criminal|convicted|background check|non-?compete|notice period|willing to relocate)\b/i },
  { kind: 'money', re: /\b(salary|compensation|desired pay|pay expectation|rate|wage|ctc)\b/i },
  { kind: 'consent', re: /\b(i agree|i consent|i acknowledge|terms|privacy policy|gdpr|opt in|subscribe|newsletter)\b/i },
  { kind: 'narrative', re: /\b(cover letter|why (do|are) you|tell us|describe|what makes you|additional information|comments|references)\b/i },
];

/**
 * Rules, most specific first.
 *
 * `auto`   — the autocomplete attribute, when the vendor sets a real one. The
 *            strongest signal there is: it is the browser's own contract, and
 *            Greenhouse sets given-name/family-name/email on its name fields.
 * `token`  — matched against id and name, on word boundaries. `candidate.phone`
 *            and `_systemfield_email` both reduce to their last word.
 * `label`  — matched against the visible label, placeholder and aria-label.
 * `not`    — refuses the rule even when something else matched.
 */
const RULES = [
  { key: 'firstName', auto: ['given-name'], token: /^(first[_-]?name|firstname|fname|given[_-]?name)$/i, label: /^(first|given)\s*name\b/i },
  { key: 'lastName', auto: ['family-name'], token: /^(last[_-]?name|lastname|lname|family[_-]?name|surname)$/i, label: /^(last|family)\s*name\b|^surname\b/i },
  { key: 'preferredName', token: /^(preferred[_-]?name|nick[_-]?name|known[_-]?as)$/i, label: /preferred\s*(first\s*)?name|what should we call you/i, not: /legal/i },
  // Full name LAST among the name rules: a form with first+last must never see
  // its "First Name" box as a full-name box.
  { key: 'fullName', auto: ['name'], token: /^(full[_-]?name|name|candidate\.name|_systemfield_name|your[_-]?name)$/i, label: /^(full\s*name|name)\b/i, not: /first|last|given|family|preferred|company|user|file|account/i },
  { key: 'email', auto: ['email'], type: ['email'], token: /(^|[._-])e?mail($|[._-])/i, label: /\be-?mail\b/i, not: /confirm|verify|again/i },
  { key: 'phone', auto: ['tel', 'tel-national'], type: ['tel'], token: /(^|[._-])(phone|mobile|tel|telephone|cell)($|[._-])/i, label: /\b(phone|mobile|telephone|cell)\b/i, not: /country code|extension|whatsapp/i },
  { key: 'linkedin', token: /linked[_-]?in|urls\[linkedin\]/i, label: /linked ?in/i },
  { key: 'github', token: /git[_-]?hub|urls\[github\]/i, label: /git ?hub/i },
  { key: 'website', token: /(website|portfolio|personal[_-]?site|urls\[portfolio\]|blog)/i, label: /\b(website|portfolio|personal site|blog)\b/i, not: /company/i },
  { key: 'currentCompany', token: /^(org|company|current[_-]?company|employer)$/i, label: /current (company|employer)|^company\b/i, not: /website|url|size/i },
  { key: 'currentTitle', token: /^(title|job[_-]?title|current[_-]?title|headline|position)$/i, label: /current (title|role|position)|^(job )?title\b|^headline\b/i },
  { key: 'address', auto: ['street-address', 'address-line1'], token: /^(address|street[_-]?address|address_?line1|streetaddress\.value)$/i, label: /^(street )?address\b/i, not: /email|city|country|postal|zip|state/i },
  { key: 'city', auto: ['address-level2'], token: /^(city|town|city\.value)$/i, label: /^(city|town)\b/i },
  { key: 'region', auto: ['address-level1'], token: /^(state|province|region|state\.value)$/i, label: /^(state|province|region)\b/i, not: /permanently reside/i },
  { key: 'postcode', auto: ['postal-code'], token: /^(zip|postcode|postal[_-]?code|zip\.value)$/i, label: /\b(zip|post(al)? ?code)\b/i },
  { key: 'country', auto: ['country', 'country-name'], token: /^(country|country\.value)$/i, label: /^country\b/i },
  // Deliberately after city/country: Greenhouse's "Location (City)" and Lever's
  // "Current location" are one box for the whole place.
  { key: 'location', token: /^(location|candidate-location|current[_-]?location)$/i, label: /\blocation\b/i, not: /relocat/i },
  { key: 'resume', file: true, token: /(resume|cv|_systemfield_resume|candidate\.cv)/i, label: /\b(resume|cv|résumé)\b/i, not: /cover/i },
];

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** The visible words for a field, however the vendor chose to attach them. */
export function labelTextFor(el, doc = el.ownerDocument) {
  const bits = [];
  if (el.id) {
    const l = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (l) bits.push(l.textContent);
  }
  const wrapping = el.closest ? el.closest('label') : null;
  if (wrapping) bits.push(wrapping.textContent);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const n = doc.getElementById(id);
      if (n) bits.push(n.textContent);
    }
  }
  if (el.getAttribute('aria-label')) bits.push(el.getAttribute('aria-label'));
  // Last resort: the nearest label above it in the same little block. Bounded to
  // three hops, because further than that reaches a different question.
  if (bits.length === 0) {
    let p = el.parentElement;
    for (let hops = 0; p && hops < 3 && bits.length === 0; hops++, p = p.parentElement) {
      const l = p.querySelector('label, legend');
      if (l) bits.push(l.textContent);
    }
  }
  return clean(bits.join(' | '));
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Everything the matcher is allowed to look at, read once.
 *
 * `visible` is computed by the caller in a real browser (offsetParent and
 * getClientRects), because jsdom has no layout and would report every field as
 * invisible, which would make the tests assert nothing.
 */
export function describeField(el, opts = {}) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
  const label = labelTextFor(el);
  return {
    el,
    tag,
    type,
    id: el.id || '',
    name: el.getAttribute('name') || '',
    auto: (el.getAttribute('autocomplete') || '').toLowerCase(),
    role: (el.getAttribute('role') || '').toLowerCase(),
    placeholder: el.getAttribute('placeholder') || '',
    label,
    required: el.required === true || el.getAttribute('aria-required') === 'true' || /[*✱]|\brequired\b/i.test(label),
    ariaHidden: el.getAttribute('aria-hidden') === 'true',
    tabIndex: el.getAttribute('tabindex'),
    visible: opts.visible !== undefined ? opts.visible : true,
    hasValue: Boolean(el.value),
  };
}

/**
 * A trap field, which must be left empty.
 *
 * BambooHR's form carries one: `<input id="nickname_hpcsaf" … label "Please
 * leave this field blank">`. Filling it marks the application as a bot. Every
 * signal here was taken from that live example or is the standard shape of the
 * same trick: hidden from people, named for the trap, or told plainly.
 */
export function isHoneypot(d) {
  if (/leave this field blank|do not fill|bot ?field/i.test(`${d.label} ${d.placeholder}`)) return true;
  if (/honey ?pot|^hp[_-]|[_-]hp$|_hpcsaf|winnie|bot_?trap/i.test(`${d.id} ${d.name}`)) return true;
  // A HIDDEN FILE INPUT IS NORMAL, NOT A TRAP.
  //
  // Every vendor hides it behind a styled drop zone: Greenhouse gives it
  // `class="visually-hidden"`, Lever `class="invisible-resume-"`, Workable wraps
  // it in a "Choose file" button. Judging file inputs by visibility classified
  // all three résumé boxes as traps, so nothing attached a CV anywhere — found
  // on the first live run against Lever and Workable.
  if (d.type === 'file') return false;
  if (d.ariaHidden || d.tabIndex === '-1') return true;
  if (!d.visible) return true;
  return false;
}

/**
 * A value the SITE put there, not the person.
 *
 * Both captured live on 17 September 2026: Workable had guessed
 * `value="Redmond, United States of America"` into its address box from the
 * visitor's IP, and Recruitee's phone box arrived holding `value="+55"` — a
 * dial code for a country nobody chose. Neither is an answer, and refusing to
 * touch them means an application goes out with a stranger's city on it.
 *
 * Kept deliberately narrow: a bare dial code, or a value identical to the
 * field's own placeholder. Anything else already holding text is treated as the
 * person's own words and is never overwritten — it is listed on the panel
 * instead, so a wrong guess like Workable's is seen rather than accepted.
 */
export function isSitePrefill(d) {
  const v = String(d.el && d.el.value !== undefined ? d.el.value : '').trim();
  if (!v) return false;
  if (/^\+?\d{1,4}$/.test(v)) return true;
  if (d.placeholder && v.toLowerCase() === d.placeholder.trim().toLowerCase()) return true;
  return false;
}

/** Why a field is being left alone, in words a person can read on the panel. */
export function refusalFor(d) {
  const text = `${d.label} ${d.placeholder} ${d.name}`;
  for (const { kind, re } of NEVER_FILL) if (re.test(text)) return kind;
  return null;
}

const SEARCHY = /^(search|filter|type to search|start typing)/i;

/**
 * Which profile key this field wants, or null.
 *
 * Returns the reason as well. The panel shows it, and a wrong fill is far
 * easier to argue about when the matcher can say "matched on autocomplete".
 */
export function matchField(d) {
  if (d.type === 'hidden' || d.type === 'submit' || d.type === 'button' || d.type === 'password') return null;
  if (isHoneypot(d)) return { key: null, why: 'honeypot' };
  const refused = refusalFor(d);
  if (refused) return { key: null, why: refused };
  // A bare "Search" box inside a picker, with no other words: Rippling renders
  // its location picker that way. Filling it types into a menu that may or may
  // not commit, so v1 leaves it to the person.
  if (SEARCHY.test(d.label) && !/location|city|country/i.test(d.label)) return { key: null, why: 'search box' };

  const haystackToken = `${d.id} ${d.name}`;
  const haystackLabel = `${d.label} ${d.placeholder}`;

  for (const rule of RULES) {
    if (rule.file && d.type !== 'file') continue;
    if (!rule.file && d.type === 'file') continue;
    if (rule.not && rule.not.test(`${haystackLabel} ${haystackToken}`)) continue;

    if (rule.auto && d.auto && rule.auto.includes(d.auto)) return { key: rule.key, why: `autocomplete="${d.auto}"` };
    if (rule.token && tokensOf(haystackToken).some((t) => rule.token.test(t))) return { key: rule.key, why: 'field name' };
    if (rule.type && rule.type.includes(d.type) && (!rule.label || rule.label.test(haystackLabel))) {
      return { key: rule.key, why: `type="${d.type}"` };
    }
    if (rule.label && rule.label.test(stripMarks(haystackLabel))) return { key: rule.key, why: 'label' };
  }
  return { key: null, why: 'not recognised' };
}

/** `candidate.phone`, `urls[LinkedIn]`, `streetAddress.value` → their words. */
function tokensOf(s) {
  const parts = String(s).split(/[\s.\[\]]+/).filter(Boolean);
  return [...parts, ...parts.map((p) => p.replace(/[_-]/g, ''))];
}

/** "* First name" and "Last Name ✱" are the same words as "first name". */
function stripMarks(s) {
  return s.replace(/[*✱]/g, ' ').replace(/\(optional\)|\brequired\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The plan for one page: what to fill, and what is being left alone and why.
 *
 * Nothing is filled twice — the first field claiming a key wins, so a form that
 * repeats "Email" for a confirmation box does not get the address typed into
 * both. A field that already holds something is left as it is: the person may
 * have typed it, and overwriting someone's own words is unforgivable.
 */
export function planFill(descriptors, profile) {
  const fills = [];
  const skipped = [];
  const used = new Set();
  const hasSplitName = descriptors.some((d) => matchField(d)?.key === 'firstName');

  for (const d of descriptors) {
    const m = matchField(d);
    if (!m || !m.key) {
      if (d.visible && !isHoneypot(d) && d.type !== 'submit' && d.type !== 'button') {
        skipped.push({ field: d, reason: m ? m.why : 'not a fillable field' });
      }
      continue;
    }
    // A single "Full name" box on a form that also has First/Last is a
    // different question (an account name, usually). Skip it.
    if (m.key === 'fullName' && hasSplitName) {
      skipped.push({ field: d, reason: 'duplicate name field' });
      continue;
    }
    const value = valueFor(m.key, profile);
    if (value === undefined || value === null || value === '') {
      skipped.push({ field: d, reason: `nothing in your profile for ${m.key}` });
      continue;
    }
    if (used.has(m.key) && m.key !== 'resume') {
      skipped.push({ field: d, reason: 'already filled above' });
      continue;
    }
    if (d.hasValue && !isSitePrefill(d)) {
      // Shown on the panel rather than silently accepted: the value may be the
      // person's own, or the site's wrong guess about where they live.
      skipped.push({ field: d, reason: 'already has a value — check it' });
      continue;
    }
    used.add(m.key);
    // A narrower second try for places. Lever's location box answered
    // "Toronto, Ontario, Canada" with "No location found", while its own
    // suggestions accept "Toronto" — measured 17 Sep 2026.
    const fallback = m.key === 'location' ? (profile || {}).city : undefined;
    fills.push({ field: d, key: m.key, value, why: m.why, ...(fallback && fallback !== value ? { fallback } : {}) });
  }
  return { fills, skipped };
}

/** Profile → the string this field wants. */
export function valueFor(key, profile) {
  const p = profile || {};
  switch (key) {
    case 'fullName':
      return [p.firstName, p.lastName].filter(Boolean).join(' ');
    case 'location':
      return [p.city, p.region, p.country].filter(Boolean).join(', ');
    case 'resume':
      return p.resume ? p.resume.name : '';
    default:
      return p[key];
  }
}
