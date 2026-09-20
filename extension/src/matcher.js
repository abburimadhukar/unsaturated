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

import { ANSWER_FIELDS, matchAnswer, choiceWords, answerField, pickOption } from './answers.js';

/** The facts we are willing to fill without anyone approving them per job. */
export const FACT_KEYS = [
  'firstName', 'middleName', 'lastName', 'fullName', 'preferredName', 'email', 'phone',
  'address', 'city', 'region', 'postcode', 'country', 'location',
  'linkedin', 'github', 'website', 'currentCompany', 'currentTitle',
  'school', 'degree', 'discipline', 'gpa', 'graduationYear', 'skills',
  'eduStart', 'eduEnd', 'jobStart', 'jobEnd',
  'confirmEmail', 'phoneCountry', 'password', 'passwordConfirm',
  'dateOfBirth', 'salutation', 'nameSuffix', 'previousName', 'address2', 'county',
  'placeOfBirth', 'maritalStatus', 'jobDescription', 'eduDescription',
  'resume', 'coverLetter',
];

/**
 * The two kinds of question this never answers, whatever is saved.
 *
 * NARRATIVE — "Why do you want to work here?", cover letters. Nobody can store
 * these in advance, and a generated paragraph is what employers now filter for.
 *
 * CONSENT — "I have read and agree…". Ticking that on someone's behalf is a
 * statement made in their name, not autofill. It stays off unless the person
 * turns "tick consent boxes" on in options, which is their decision to make.
 *
 * Everything else an employer asks — sponsorship, work authorisation, notice
 * period, salary, demographics — is answered ONLY from an answer the person
 * typed into the options page themselves. See answers.js. Nothing is inferred:
 * an answer that is not saved is left blank and reported.
 */
export const NEVER_FILL = [
  // Free text about this employer. Nobody can store this in advance, and a
  // generated paragraph is exactly what employers now filter for.
  { kind: 'narrative', re: /\b(cover letter|why (do|are|would) you|tell us|describe|what makes you|what draws you|additional information|anything else|comments|references)\b/i },
  // Ticking "I have read and agree" on someone's behalf is not autofill, it is a
  // statement made in their name. Off unless they turn it on in options.
  { kind: 'consent', re: /\b(i (have read|agree|consent|acknowledge|certify|declare)|terms|privacy (policy|notice|information)|gdpr|opt in|subscribe|newsletter|marketing)\b/i },
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
  // DATES, first, and only for date boxes. Breezy's education and job blocks
  // hold <input type=date> with no label and — a vendor slip — the placeholder
  // "Company"; the only honest name is ng-model="candidateSchool.date_start".
  // Tried first so "Company" never puts a company name into a date box, and
  // tried only on boxes that ask for a date (see isDateBox).
  { key: 'eduStart', date: true, all: [/school|education|degree|universit|college|academic/i, /start|from|begin/i] },
  { key: 'eduEnd', date: true, all: [/school|education|degree|universit|college|academic/i, /\bend|date_end|enddate|\bto\b|until|graduat|finish|complet/i] },
  { key: 'jobStart', date: true, all: [/position|\bjob|work|employ|experience|company|\brole/i, /start|from|begin/i] },
  { key: 'jobEnd', date: true, all: [/position|\bjob|work|employ|experience|company|\brole/i, /\bend|date_end|enddate|\bto\b|until|finish/i] },
  // FULL DETAILS — what Oracle, Workday and other long forms ask beyond a name.
  // The date of birth is taken only from the full date saved in options; a
  // saved year alone never becomes a birthday (see fill.shapeFor).
  { key: 'dateOfBirth', anyType: true, auto: ['bday'], token: /^(dob|date[_-]?of[_-]?birth|dateofbirth|birth[_-]?date|birthdate|birthday)$/i, label: /\b(date of birth|birth ?date|birthday|d\.o\.b\.?|dob)\b|geburtsdatum/i, not: /year of birth|place of birth|country of birth|city of birth|birth ?place/i },
  // "Title" as a MENU (Mr / Ms / Dr) is a salutation; as a text box it is a
  // job title, handled further down.
  { key: 'salutation', menuOnly: true, auto: ['honorific-prefix'], token: /^(salutation|title|name[_-]?prefix|nameprefix|honorific|prefix)$/i, label: /\b(salutation|name prefix|honorific)\b|^(title|prefix)\b/i, not: /job|position|role|current/i },
  { key: 'placeOfBirth', token: /^(place[_-]?of[_-]?birth|placeofbirth|birth[_-]?place|birthplace|town[_-]?of[_-]?birth)$/i, label: /\b(place|town|city) of birth\b|\bbirth ?place\b/i },
  { key: 'maritalStatus', menuOrText: true, token: /marital[_-]?status|maritalstatus/i, label: /\bmarital status\b|\bcivil status\b/i },
  // What you did in a job, or at a school — only in the box a job or school
  // block holds for it: Breezy's ng-model="candidatePosition.summary",
  // SmartRecruiters' id="exp-desc-…". A form's own "Summary" is not this.
  { key: 'jobDescription', raw: /candidatePosition\.(summary|description)|(^|\s)exp-desc-|experience\[\d*\]\.?description/i },
  { key: 'eduDescription', raw: /candidateSchool\.(summary|description)|(^|\s)edu-desc-|education\[\d*\]\.?description/i },
  { key: 'nameSuffix', auto: ['honorific-suffix'], token: /^(suffix|name[_-]?suffix|namesuffix)$/i, label: /^suffix\b|\bname suffix\b/i },
  { key: 'previousName', token: /^(previous[_-]?(last[_-]?)?name|maiden[_-]?name|former[_-]?(last[_-]?)?name|previouslastname|maidenname)$/i, label: /\b(previous|former|maiden|birth) (last |family |sur)?name\b|\bother (last )?names? (used|known by)\b/i, not: /\b(have|are|were) you\b/i },
  { key: 'firstName', auto: ['given-name'], token: /^(first[_-]?name|firstname|fname|given[_-]?name)$/i, label: /^(first|given)\s*name\b/i },
  { key: 'middleName', auto: ['additional-name'], token: /^(middle[_-]?name|middlename|mname)$/i, label: /^middle\s*(name|initial)/i },
  { key: 'lastName', auto: ['family-name'], token: /^(last[_-]?name|lastname|lname|family[_-]?name|surname)$/i, label: /^(last|family)\s*name\b|^surname\b/i },
  { key: 'preferredName', token: /^(preferred[_-]?name|nick[_-]?name|known[_-]?as)$/i, label: /preferred\s*(first\s*)?name|what should we call you/i, not: /legal/i },
  // Full name LAST among the name rules: a form with first+last must never see
  // its "First Name" box as a full-name box.
  { key: 'fullName', auto: ['name'], token: /^(full[_-]?name|name|candidate\.name|_systemfield_name|your[_-]?name)$/i, label: /^(full\s*name|name)\b|\b(legal|preferred) full name\b|\bfirst and last name\b|^your (full )?name\b/i, not: /^\s*(first|last|given|family|middle) name\b|preferred (first )?name\b(?! full)|company|user|file|account|^\s*(are|will|do|does|did|have|has|would|can|could|is|were|may) you\b|\b(are|will|do|would|have) you\b/i },
  { key: 'email', auto: ['email'], type: ['email'], token: /(^|[._-])e?mail($|[._-])/i, label: /\be-?mail\b/i, not: /confirm|verify|again|re-?enter|repeat|retype/i },
  // "Confirm your email" — required on SmartRecruiters, and the same address.
  { key: 'confirmEmail', token: /confirm[_-]?e?mail|e?mail[_-]?confirm|verify[_-]?e?mail|email2|re[_-]?enter[_-]?email/i, label: /\b(confirm|verify|re-?enter|repeat|retype)\b.{0,20}\be-?mail\b|\be-?mail\b.{0,20}\b(again|confirm\w*)\b/i },
  // The phone's COUNTRY CODE picker: Oracle's "Phone Number | Country code",
  // pre-set to the employer's +39. Before the phone rule, so the number box and
  // its code picker are told apart by the words, not refused together.
  { key: 'phoneCountry', token: /country[_-]?codes?|countrycode|dial[_-]?code|phone[_-]?country|phonecode/i, label: /(^|\|\s*)((tele)?phone )?country (calling )?code\b|\btelephone country\b|\bdial(l?ing)? code\b/i },
  // "Phone number with country code" (Teamtailor) IS the phone number; an
  // earlier "not: country code" refused it on every Teamtailor form.
  { key: 'phone', auto: ['tel', 'tel-national'], type: ['tel'], token: /(^|[._-])(phone|mobile|tel|telephone|cell)($|[._-])/i, label: /\b(phone|mobile|telephone|cell)\b/i, not: /extension|whatsapp/i },
  { key: 'linkedin', token: /linked[_-]?in|urls\[linkedin\]/i, label: /linked ?in/i },
  { key: 'github', token: /git[_-]?hub|urls\[github\]/i, label: /git ?hub/i },
  // Framestore's "Showreel *" is a film/VFX portfolio link.
  { key: 'website', token: /(website|portfolio|personal[_-]?site|urls\[portfolio\]|blog|showreel|demo[_-]?reel)/i, label: /\b(website|portfolio|personal site|blog|show ?reel|demo reel)\b/i, not: /company/i },
  { key: 'currentCompany', token: /^(org|company|company[_-]?name|current[_-]?company|employer)$/i, label: /\b(current|most recent|latest|present)\b[\w\s\/]{0,25}\b(company|employer|organi[sz]ation)\b|^company\b/i, not: /website|url|size|agreement|restriction|non-?compete|contact|permission|reference|^\s*(are|will|do|does|did|have|has|would|can|could|is|were|may) you\b|\b(are|will|do|would|have) you\b/i },
  { key: 'currentTitle', token: /^(title|job[_-]?title|current[_-]?title|headline|position)$/i, label: /\b(current|most recent|latest|present)\b[\w\s\/]{0,25}\b(job )?(title|role|position)\b|^(job )?title\b|^headline\b/i, not: /^\s*(are|will|do|does|did|have|has|would|can|could|is|were|may) you\b|\b(are|will|do|would|have) you\b/i },
  // EDUCATION, from the first school on the profile (the résumé's most recent).
  // Greenhouse's newer forms and Workday both ask these as separate boxes.
  { key: 'school', token: /^(school|school[_-]?name|schoolname|university|institution|college)$/i, label: /\b(school|university|college|institution)( name)?\b/i, not: /high school (diploma|graduate)|graduat|degree|discipline|major|field of study|gpa|\byear\b|\bdate\b|type|level|highest|e-?mail|attend(ed)? any/i },
  { key: 'degree', token: /^(degree|degree[_-]?type|degreetype|degreedropdown|degree[_-]?level)$/i, label: /^degree\b|\bdegree (type|level|obtained|earned|name)\b/i, not: /school|discipline|major|field|\byear\b|\bdate\b/i },
  { key: 'discipline', token: /^(discipline|major|field[_-]?of[_-]?study|fieldofstudy|area[_-]?of[_-]?study|specialization)$/i, label: /\b(discipline|major|field of study|area of study|specialization|specialisation|course of study)\b/i },
  { key: 'gpa', token: /^(gpa|cgpa|overall[_-]?result|grade[_-]?average)$/i, label: /\b(c?gpa|grade point|overall (result|grade))\b/i },
  { key: 'graduationYear', token: /^(graduation[_-]?(year|date)|gradyear|grad[_-]?year)$/i, label: /\b(graduation|grad) (year|date)\b|\byear of graduation\b|\bexpected graduation\b|\bdate of graduation\b/i },
  // A plain "Skills" box. Not a skills PICKER: typing a whole list into a menu
  // commits nothing, so those are left for the person (textOnly).
  { key: 'skills', textOnly: true, token: /^(skills?|key[_-]?skills)$/i, label: /^(key |technical )?skills?\b/i, not: /years|level|rate|describe|how/i },
  { key: 'address', auto: ['street-address', 'address-line1'], token: /^(address|street[_-]?address|streetaddress|address_?line_?1|address1|streetaddress\.value)$/i, label: /^(street( address| and (house )?number| name)?|address( line)?( ?1)?|home address|mailing address|residential address|stra(ss|ß)e)\b/i, not: /e-?mail|city|country|postal|zip|state|line ?2|\bapt\b|suite/i },
  { key: 'address2', auto: ['address-line2'], token: /^(address[_-]?line[_-]?2|address2|addressline2|street[_-]?address[_-]?2|apt|suite|unit)$/i, label: /\baddress (line )?2\b|^(apartment|apt\.?|suite|unit|flat)\b/i, not: /e-?mail|line 1|line ?3|business unit/i },
  { key: 'county', token: /^(county|county\.value)$/i, label: /^county\b/i },
  { key: 'city', auto: ['address-level2'], token: /^(city|town|city\.value)$/i, label: /^(city|town)\b/i },
  // Ashby: "In which state do you permanently reside?" is the state, asked as a
  // question; "Do you reside in the state of …?" is a yes/no and is not.
  { key: 'region', auto: ['address-level1'], token: /^(state|province|region|state\.value)$/i, label: /^(state|province|region)\b|\b(which|what) (u\.?s\.? )?(state|province)\b|\bstate of residence\b|\bstate (you|do you) (live|reside)\b/i, not: /^\s*(do|are|is|have|will) you\b|statement/i },
  // JazzHR: <input name="resumator-postal-value" placeholder="Postal">.
  { key: 'postcode', auto: ['postal-code'], token: /^(zip|postcode|postal[_-]?code|zip\.value|resumator-postal-value)$/i, label: /\b(zip|post(al)? ?code)\b|^postal$/i },
  { key: 'country', auto: ['country', 'country-name'], token: /^(country|country\.value)$/i, label: /^country\b|\bcountry (where|in which) you (currently )?(reside|live)\b|\bcountry of (current )?residence\b|\bcountry you (currently )?(live|reside) in\b/i, not: /citizenship|passport|birth|nationality|authori[sz]ed|sponsor|^\s*(are|will|do|does|did|have|has|would|can|could|is|were|may) you\b|\b(are|will|do|would|have) you\b/i },
  // Deliberately after city/country: Greenhouse's "Location (City)" and Lever's
  // "Current location" are one box for the whole place.
  // Recruitee: "Where in the US are you based?" is the same question.
  { key: 'location', token: /^(location|candidate-location|current[_-]?location)$/i, label: /\blocation\b|\bwhere\b.{0,30}\b(are you|do you) (currently )?(based|located|live|reside)\b/i, not: /relocat|willing|open to|desired|preferred|prefer|would you like|want to work|work from|^\s*(are|will|do|does|did|have|has|would|can|could|is|were|may) you\b|\b(are|will|do|would|have) you\b/i },
  // `accepts` is the last resort for a file input with no name and no words:
  // BambooHR's is `<input type=file aria-label="file-input"
  // accept=".pdf,.doc,.docx,…">` beside the text "Choose File*". A box that
  // takes documents, on a job application, is the CV box.
  {
    key: 'resume',
    file: true,
    token: /(resume|cv|_systemfield_resume|candidate\.cv)/i,
    label: /\b(resume|cv|résumé)\b/i,
    accepts: /pdf|\.docx?|rtf|odt/i,
    not: /cover|photo|portfolio|transcript|certificate|apply-with-resume|autofill|parse/i,
  },
  // Your cover-letter FILE, when you have saved one. Never written for you.
  { key: 'coverLetter', file: true, token: /cover[_-]?letter|coverletter/i, label: /\bcover(ing)? letter\b|\bmotivation(al)? letter\b/i },
];

// Workable's icons carry the fallback text "SVGs not supported by this
// browser.", which lands inside every label that has an icon beside it.
const clean = (s) => (s || '').replace(/SVGs not supported by this browser\.?/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s|]+|[\s|]+$/g, '').trim();

/** The visible words for a field, however the vendor chose to attach them. */
export function labelTextFor(el, doc = el.ownerDocument) {
  // A field inside a web component (SmartRecruiters' <spl-input>) has its
  // <label for> inside the same shadow root, where document.querySelector
  // cannot see it. Its own root is searched first.
  const root = el.getRootNode && el.getRootNode() !== doc && el.getRootNode().querySelector ? el.getRootNode() : doc;
  const byId = (id) => (root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id);
  const bits = [];
  // Ashby's yes/no box is <input type=checkbox name="0c68…"> with no id, under
  // <label for="0c68…">: the label points at its NAME.
  for (const key of [el.id, !el.id && el.getAttribute('name')].filter(Boolean)) {
    const l = root.querySelector(`label[for="${cssEscape(key)}"]`) || doc.querySelector(`label[for="${cssEscape(key)}"]`);
    if (l) {
      bits.push(l.textContent);
      break;
    }
  }
  const wrapping = el.closest ? el.closest('label') : null;
  if (wrapping) bits.push(wrapping.textContent);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const n = byId(id);
      if (n) bits.push(n.textContent);
    }
  }
  // A menu's aria-label is often only its prompt — Rippling's "Are you legally
  // authorized to work in the United States?" menu is aria-label="Select", with
  // the question in a <p> above it. A prompt is not a question.
  const aria = el.getAttribute('aria-label');
  if (aria && !FILLER.test(aria.trim())) bits.push(aria);
  // Last resort: the nearest label above it in the same little block. Bounded to
  // three hops, because further than that reaches a different question.
  //
  // Headings count too: Breezy titles every question with an <h3> above the
  // dropdown and no label at all, so each one read as "not recognised".
  if (bits.length === 0) {
    let p = el.parentElement;
    for (let hops = 0; p && hops < 3 && bits.length === 0; hops++, p = p.parentElement) {
      // Headings only for a box with no words of its own: a section heading
      // ("Experience") above Breezy's "Company" box hid its placeholder.
      const l = p.querySelector(el.getAttribute('placeholder') ? 'label, legend' : 'label, legend, h1, h2, h3, h4, h5');
      if (l) bits.push(l.textContent);
    }
  }
  // Then the component's own "label" attribute: <spl-input label="City">.
  if (bits.length === 0 && root !== doc && root.host) {
    const own = root.host.getAttribute('label') || root.host.getAttribute('splarialabel') || root.host.getAttribute('arialabel');
    if (own) bits.push(own);
  }
  // Last of all, the words written just above it, whatever element holds them.
  if (bits.length === 0 && (!el.getAttribute('placeholder') || PROMPT.test(el.getAttribute('placeholder').trim()))) {
    const above = textBefore(el);
    if (above) bits.push(above);
  }
  // Only a prompt after all: better than nothing for the panel.
  if (bits.length === 0 && aria) bits.push(aria);
  return clean(bits.join(' | '));
}

/** The Yes and No buttons beside a hidden tick box, or null. */
function yesNoButtons(el) {
  const box = el.parentElement;
  if (!box) return null;
  const buttons = [...box.querySelectorAll('button')].filter((b) => /^(yes|no)$/i.test((b.textContent || '').trim()));
  return buttons.length === 2 ? buttons : null;
}

/** A placeholder that only says "type here": no words of the question in it. */
const PROMPT = /^(type|enter|write|add|select|choose|start typing|your answer|answer)\b.{0,30}$|^\W*$/i;

/** "Select", "Select...", "Search", "Choose one" — a prompt, not a question. */
const FILLER = /^(select|search|choose|pick|type here|type to search|start typing|enter|--)\b[\s\w]{0,12}(\.\.\.|…)?$|^(select|choose)\s*(an? )?(option|one)?\W*$/i;

const CONTROL = 'input:not([type=hidden]), select, textarea, [role="combobox"], [role="radiogroup"], [role="radio"], [role="checkbox"]';

/**
 * The words written just before a box: the nearest earlier sibling, at each
 * level going up, that holds text and no other box. Rippling writes its
 * questions as <p> in a block beside the field's own; nothing links the two.
 * It stops at the first earlier block holding another box: past that is a
 * different question.
 */
export function textBefore(el, maxHops = 8) {
  let child = el;
  for (let hops = 0; child && child.parentElement && hops < maxHops; hops++) {
    for (let sib = child.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.matches(CONTROL) || sib.querySelector(CONTROL)) return '';
      if (/^(SCRIPT|STYLE|TEMPLATE|svg)$/i.test(sib.tagName)) continue;
      const text = clean(sib.textContent);
      if (text.length >= 3 && !FILLER.test(text)) return text.slice(0, 300);
    }
    child = child.parentElement;
  }
  return '';
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
  // A menu drawn as <div role="combobox"> (Rippling's Gender, Hispanic/Latino,
  // Veteran and Disability) is a field too, though not an <input>: it has no
  // value to type, only an option to pick.
  const ariaChoice = tag !== 'input' && /^(radio|checkbox)$/.test(el.getAttribute('role') || '') ? el.getAttribute('role') : '';
  const menuBox = !ariaChoice && tag !== 'input' && tag !== 'select' && tag !== 'textarea';
  const type = ariaChoice || (menuBox ? 'combobox' : (el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase());
  const shown = menuBox ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  // A pill's own words are its label: "Mrs.", "Yes".
  const label = ariaChoice ? clean(el.getAttribute('aria-label') || el.textContent) : labelTextFor(el);
  // DATA ATTRIBUTES ARE OFTEN THE ONLY HONEST NAME ON THE FIELD.
  //
  // Rippling's phone box is `id="field-35" name="yPLgVcjvlUP"` — positional and
  // random — but carries `data-input="phone_number"` and `inputmode="tel"`.
  // Workday names every element with `data-automation-id`. Ignoring these threw
  // away the clearest signal on two of the biggest vendors.
  // Framework bindings name fields too: Breezy's date boxes are known only by
  // ng-model="candidateSchool.date_start".
  const data = ['data-input', 'data-testid', 'data-qa', 'data-automation-id', 'data-field', 'data-name', 'ng-model', 'formcontrolname', 'v-model', 'data-sr-id']
    .map((a) => el.getAttribute(a))
    // Inside a web component the naming is on the HOST: SmartRecruiters' two
    // résumé boxes differ only by <spl-dropzone data-test="apply-with-resume-
    // container"> versus data-test="resume-upload".
    // Every component around it, not only the nearest: SmartRecruiters' job
    // title is <spl-autocomplete data-test="job-title-autocomplete"> around
    // <spl-input> around the <input>, and only the outer one says "job".
    .concat(hostsOf(el).flatMap((h) => ['data-test', 'data-testid', 'data-sr-id'].map((a) => h.getAttribute(a))))
    .filter(Boolean)
    .join(' ');
  return {
    el,
    tag,
    type,
    data,
    inputMode: (el.getAttribute('inputmode') || '').toLowerCase(),
    accept: (el.getAttribute('accept') || '').toLowerCase(),
    id: el.id || '',
    name: el.getAttribute('name') || '',
    auto: (el.getAttribute('autocomplete') || '').toLowerCase(),
    role: (el.getAttribute('role') || '').toLowerCase(),
    placeholder: el.getAttribute('placeholder') || '',
    label,
    required: el.required === true || el.getAttribute('aria-required') === 'true' || /[*✱]|\brequired\b/i.test(label),
    ariaHidden: el.getAttribute('aria-hidden') === 'true',
    menuButton: tag === 'select' && Boolean(el.parentElement && el.parentElement.closest('[data-fabric-component="Select"]')),
    // Ashby asks yes/no as two buttons over a hidden tick box:
    // <button data-option="yes">Yes</button><button data-option="no">No</button>
    // <input type=checkbox tabindex=-1>. The buttons are the answer.
    buttons: type === 'checkbox' ? yesNoButtons(el) : null,
    tabIndex: el.getAttribute('tabindex'),
    visible: opts.visible !== undefined ? opts.visible : true,
    // A tick box's value is "on" whether or not it is ticked, so its answer is
    // whether it is CHECKED. Reading .value reported every empty box on Ashby's
    // diversity questions as "already has a value".
    hasValue: type === 'checkbox' || type === 'radio' ? isChecked(el)
      : menuBox ? Boolean(shown) && !/^(select|choose|please select|--)/i.test(shown)
      // Angular leaves an empty <select> on "? undefined:undefined ?"; that is
      // no answer, and Breezy's questions read as "already answered".
      : tag === 'select' ? selectAnswered(el) || Boolean(menuText(el))
      : Boolean(el.value),
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
  // Workday's is labelled "Enter website. This input is for robots only, do not
  // enter if you're human." and named data-automation-id="beecatcher". It reads
  // as a website box, and filling it marks the applicant as a bot.
  if (/leave this field blank|do not fill|bot ?field|for robots|robots only|if you'?re (a )?human/i.test(`${d.label} ${d.placeholder}`)) return true;
  if (/honey ?pot|^hp[_-]|[_-]hp$|_hpcsaf|winnie|bot_?trap|beecatcher/i.test(`${d.id} ${d.name} ${d.data || ''}`)) return true;
  // A HIDDEN FILE INPUT IS NORMAL, NOT A TRAP.
  //
  // Every vendor hides it behind a styled drop zone: Greenhouse gives it
  // `class="visually-hidden"`, Lever `class="invisible-resume-"`, Workable wraps
  // it in a "Choose file" button. Judging file inputs by visibility classified
  // all three résumé boxes as traps, so nothing attached a CV anywhere — found
  // on the first live run against Lever and Workable.
  if (d.type === 'file') return false;
  // The same holds for round buttons and tick boxes: Workable hides the real
  // <input type=radio> (aria-hidden, tabindex -1) behind a styled role="radio"
  // div, and its "Yes, please process my application" pair was reported as a
  // trap. Only the words and names above can mark one of these as a trap.
  if (d.type === 'radio' || d.type === 'checkbox') return false;
  // And for menus: BambooHR's State, Country and Education are a <select
  // aria-hidden tabindex=-1> recording what its visible button's menu picked.
  // Judged as traps, all three were skipped without a word on the panel.
  if (d.tag === 'select') return !d.visible && !d.menuButton;
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
  const m = matchFieldRaw(d);
  // A MENU in a phone field is its dialling-code picker: Workable's phone
  // box comes with a <select> of "+1 United States", "+44 United Kingdom"…
  if (m && m.key === 'phone' && d.tag === 'select') return { key: 'phoneCountry', why: 'the menu beside the phone number' };
  return m;
}

function matchFieldRaw(d) {
  if (d.type === 'hidden' || d.type === 'submit' || d.type === 'button') return null;
  if (isHoneypot(d)) return { key: null, why: 'honeypot' };
  // Account pages (Workday, UKG, Oracle): the job-site password the person
  // saved, in the password box and again in its "verify" twin. Never anything
  // else in a password box.
  if (d.type === 'password') {
    const words = `${d.label} ${d.placeholder} ${d.id} ${d.name} ${d.data || ''}`;
    return /confirm|verify|re-?enter|repeat|retype|again/i.test(words)
      ? { key: 'passwordConfirm', why: 'password box' }
      : { key: 'password', why: 'password box' };
  }
  const refused = d.type === 'file' ? null : refusalFor(d);
  if (refused) return { key: null, why: refused };
  // A bare "Search" box inside a picker, with no other words: Rippling renders
  // its location picker that way. Filling it types into a menu that may or may
  // not commit, so v1 leaves it to the person.
  if (SEARCHY.test(d.label) && !/location|city|country/i.test(d.label)) return { key: null, why: 'search box' };

  const haystackToken = `${d.id} ${d.name} ${d.data || ''}`;
  const haystackLabel = `${d.label} ${d.placeholder}`;
  const dateBox = isDateBox(d);

  for (const rule of RULES) {
    // Date rules only on date boxes, and a date box only takes a date rule.
    if (rule.date) {
      if (!dateBox) continue;
      const words = `${haystackLabel} ${haystackToken}`;
      if (rule.all.every((re) => re.test(words))) return { key: rule.key, why: 'date box' };
      continue;
    }
    if (d.type === 'date' && !rule.anyType) continue;
    if (rule.menuOnly && !(d.tag === 'select' || d.role === 'combobox' || d.type === 'combobox')) continue;
    if (rule.file && d.type !== 'file') continue;
    if (!rule.file && d.type === 'file') continue;
    if (rule.textOnly && (d.role === 'combobox' || d.tag === 'select')) continue;
    if (rule.not && rule.not.test(`${haystackLabel} ${haystackToken}`)) continue;

    if (rule.auto && d.auto && rule.auto.includes(d.auto)) return { key: rule.key, why: `autocomplete="${d.auto}"` };
    if (rule.raw) {
      if (rule.raw.test(haystackToken)) return { key: rule.key, why: 'field name' };
      continue;
    }
    if (rule.token && tokensOf(haystackToken).some((t) => rule.token.test(t))) return { key: rule.key, why: 'field name' };
    if (rule.type && rule.type.includes(d.type) && (!rule.label || rule.label.test(haystackLabel))) {
      return { key: rule.key, why: `type="${d.type}"` };
    }
    if (rule.label && rule.label.test(stripMarks(haystackLabel))) return { key: rule.key, why: 'label' };
    if (rule.accepts && d.accept && rule.accepts.test(d.accept)) return { key: rule.key, why: 'accepts documents' };
  }
  return { key: null, why: 'not recognised' };
}

/**
 * What the button in front of a hidden <select> shows (BambooHR: "United
 * States", or "–Select–" when nothing is chosen). Empty for any other select.
 */
function menuText(el) {
  const wrap = el.parentElement && el.parentElement.closest('[data-fabric-component="Select"]');
  const button = wrap && wrap.querySelector('button[aria-haspopup]');
  const text = button ? (button.textContent || '').replace(/\s+/g, ' ').trim() : '';
  return /^[\u2013\u2014-]*\s*(select|choose|please select)\b/i.test(text) ? '' : text;
}

/** The saved Hispanic/Latino answer, when an "ethnicity" question's options are only that. */
function hispanicInstead(field, labels, answers) {
  if (!field || field.key !== 'ethnicity' || !answers.hispanicLatino) return '';
  return labels.some((l) => /hispanic|latin[oax]/i.test(l)) && labels.every((l) => /hispanic|latin[oax]|decline|prefer|wish|answer|select|disclose|choose not/i.test(l)) ? answers.hispanicLatino : '';
}

/** Oracle's phone-code picker: <input id="country-codes-dropdownphoneNumber">. */
function codePickerBeside(descriptors) {
  return descriptors.some((x) => /country-?codes?-?dropdown/i.test(`${x.id} ${x.name}`));
}

/** "+1 415 555 0142" → "415 555 0142", using the saved country's dialling code. */
export function nationalNumber(phone, country) {
  const raw = String(phone || '').trim();
  if (!raw.startsWith('+')) return raw;
  const code = choiceWords(country).find((w) => /^\+\d+$/.test(w));
  if (!code) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits.startsWith(code)) return '';
  return raw.replace(/^\s*\+\s*/, '').replace(new RegExp(`^${code.slice(1)}[\\s.-]*`), '').trim();
}

/** Ticked: a real box's checked, or a drawn one's aria-checked. */
export function isChecked(el) {
  return Boolean(el && (el.checked === true || el.getAttribute?.('aria-checked') === 'true'));
}

/** The web components an element sits inside, innermost first. */
function hostsOf(el) {
  const out = [];
  for (let node = el; node && node.getRootNode; ) {
    const root = node.getRootNode();
    if (!root || !root.host) break;
    out.push(root.host);
    node = root.host;
  }
  return out;
}

/** Whether a <select> holds a real choice, not a blank or "Select…" first entry. */
function selectAnswered(el) {
  const o = el.selectedOptions && el.selectedOptions[0];
  if (!o || !o.value || /^\?/.test(o.value)) return false;
  const text = (o.textContent || '').trim();
  return Boolean(text) && !/^(select|choose|please select|--)/i.test(text);
}

/**
 * The words of a question: its label, and its placeholder only when that says
 * something. "Type here...", "Select..." and "Enter your answer" are the same on
 * every box, and "here" in one made a referral question look like "worked here".
 */
function questionText(d) {
  const ph = String(d.placeholder || '').trim();
  const filler = /^(type|enter|select|choose|search|start typing|your answer|write|add)\b|^\W*$|\.\.\.$|…$/i.test(ph);
  return filler ? d.label : `${d.label} ${ph}`;
}

/**
 * Why a box that already holds something is left alone — naming what it holds
 * when that is short, because "the site chose USD" is something to check and
 * "already has a value" is not.
 */
function alreadyReason(d) {
  const now = currentText(d);
  return now && now.length <= 40 ? `already set to "${now}" — check it` : 'already has a value — check it';
}

/** A box that asks for a date: a date input, or one whose words say so. */


function isDateBox(d) {
  if (d.type === 'date' || d.type === 'month') return true;
  return /\b(date|mm\s*\/\s*yyyy|yyyy-mm|month|dd\/mm)\b/i.test(`${d.label} ${d.placeholder}`) && !/\bbirth\b|\bavailab/i.test(`${d.label} ${d.placeholder}`);
}

/** `candidate.phone`, `urls[LinkedIn]`, `streetAddress.value` → their words. */
function tokensOf(s) {
  const parts = String(s).split(/[\s.\[\]]+/).filter(Boolean);
  // Workday's data-automation-id is "section_field": "legalNameSection_firstName",
  // "addressSection_city". The part after the last underscore is the field.
  // Only that exact shape: Breezy's "school_name" split the same way became
  // "name", and the school box was filled with the person's full name.
  const tails = parts.filter((p) => /Section_[a-z]/i.test(p)).map((p) => p.slice(p.lastIndexOf('_') + 1));
  return [...parts, ...parts.map((p) => p.replace(/[_-]/g, '')), ...tails];
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
  const answers = (profile || {}).answers || {};
  const tickConsents = Boolean((profile || {}).tickConsents);

  // Radios and checkboxes are answered as a GROUP: the question sits on the
  // fieldset ("Will you require sponsorship?") and the answer is one option's
  // label ("No"). Done first so members are not considered again below.
  const groups = groupChoices(descriptors);
  const grouped = new Set();
  for (const group of groups) {
    for (const member of group.members) grouped.add(member);
    const custom = matchCustom(group.question, profile);
    const field = custom ? null : matchAnswer(group.question);
    if (!field && !custom) {
      const fact = factForGroup(group.question, profile);
      if (fact) {
        const i = pickOption(group.members.map(optionText), fact.value);
        if (i >= 0 && !group.members.some((m) => isChecked(m.el))) {
          fills.push({ field: group.members[i], key: fact.key, value: fact.value, why: 'your details', choice: true, question: group.question });
          continue;
        }
      }
      skipped.push({ field: group.members[0], reason: 'not recognised', question: group.question, members: group.members });
      continue;
    }
    const saved = custom ? custom.answer : savedAnswerFor(field, answers, group.question);
    if (!saved) {
      skipped.push({ field: group.members[0], reason: `no saved answer for "${field.label}"`, question: group.question, members: group.members, answerKey: field.key });
      continue;
    }
    if (group.members.some((m) => isChecked(m.el))) {
      skipped.push({ field: group.members[0], reason: 'already answered — check it', question: group.question });
      continue;
    }
    // Every answer is looked for in all its wordings, not only yes/no ones: a
    // saved gender of "Prefer not to say" is Ashby's "I prefer not to answer",
    // and matching only the exact words left that group unanswered.
    //
    // "Select all that apply" (tick boxes) takes several answers, saved with
    // commas between them: "White, Asian" ticks both.
    const labels = group.members.map(optionText);
    const parts = group.members[0].type === 'checkbox' ? String(saved).split(/\s*[,;]\s*|\s+and\s+/i).filter(Boolean) : [saved];
    let picks = [...new Set(parts.map((part) => pickOption(labels, part)).filter((i) => i >= 0))].map((i) => group.members[i]);
    // Oracle's US "Ethnicity" is the Hispanic-or-Latino question (Ford:
    // "Hispanic or Latino / Not Hispanic or Latino"); a race such as "White"
    // answers none of it, the saved Hispanic/Latino answer does.
    const alt = hispanicInstead(field, labels, answers);
    if (!picks.length && alt) {
      const i = pickOption(labels, alt);
      if (i >= 0) picks = [group.members[i]];
    }
    if (!picks.length) {
      skipped.push({
        field: group.members[0],
        reason: `your answer "${saved}" matches none of the options`,
        question: group.question,
      });
      continue;
    }
    for (const pick of picks) {
      fills.push({
        field: pick,
        key: custom ? 'custom' : field.key,
        value: saved,
        why: custom ? `your answer for "${custom.match}"` : 'your saved answer',
        choice: true,
        question: group.question,
      });
    }
  }

  for (const d of descriptors) {
    if (grouped.has(d)) continue;
    const m = matchField(d);

    // Ashby's Yes / No buttons: answered like any yes/no question, by pressing
    // the button that says the saved answer.
    if (d.buttons) {
      const question = d.label;
      const custom = matchCustom(question, profile);
      const field = custom ? null : matchAnswer(question);
      if (!field && !custom) {
        if (d.required) skipped.push({ field: d, reason: 'not recognised', question });
        continue;
      }
      const saved = custom ? custom.answer : savedAnswerFor(field, answers, question);
      if (!saved) {
        skipped.push({ field: d, reason: `no saved answer for "${field.label}"`, question, answerKey: field.key });
        continue;
      }
      if (d.buttons.some((b) => b.getAttribute('aria-pressed') === 'true')) {
        skipped.push({ field: d, reason: 'already answered — check it', question });
        continue;
      }
      const i = pickOption(d.buttons.map((b) => b.textContent || ''), saved);
      if (i < 0) {
        skipped.push({ field: d, reason: `your answer "${saved}" is neither Yes nor No`, question });
        continue;
      }
      fills.push({ field: d, key: custom ? 'custom' : field.key, value: saved, why: custom ? `your answer for "${custom.match}"` : 'your saved answer', choice: true, button: d.buttons[i], question });
      continue;
    }

    // A tick box or round button on its own is a statement, not a text box: it
    // is never typed into. The only thing done to one is ticking a consent,
    // and only when the person asked for that.
    if ((d.type === 'checkbox' || d.type === 'radio') && !(m && m.why === 'consent')) {
      if (d.required && d.visible) skipped.push({ field: d, reason: m && m.key ? 'a tick box — check it yourself' : (m ? m.why : 'not recognised') });
      continue;
    }

    // A question you have answered once in options: sponsorship, notice, salary.
    if (!m || !m.key) {
      const refusedKind = m ? m.why : '';
      if (!['honeypot', 'narrative', 'consent'].includes(refusedKind)) {
        // Your own question/answer pairs come first: an employer asking
        // "Do you have hands-on experience with MT4 and MT5?" cannot be
        // anticipated by any built-in list, and a pair you wrote yourself is a
        // better answer than none.
        const custom = matchCustom(questionText(d), profile);
        if (custom) {
          if (d.hasValue && !isSitePrefill(d)) {
            skipped.push({ field: d, reason: alreadyReason(d) });
            continue;
          }
          fills.push({ field: d, key: 'custom', value: custom.answer, why: `your answer for "${custom.match}"` });
          continue;
        }
        const field = matchAnswer(questionText(d));
        if (field) {
          const saved = savedAnswerFor(field, answers, questionText(d));
          if (!saved) {
            skipped.push({ field: d, reason: `no saved answer for "${field.label}"`, answerKey: field.key });
            continue;
          }
          if (d.hasValue && !isSitePrefill(d)) {
            skipped.push({ field: d, reason: alreadyReason(d) });
            continue;
          }
          fills.push({ field: d, key: field.key, value: saved, why: 'your saved answer', ...(field.key === 'ethnicity' && answers.hispanicLatino ? { alt: answers.hispanicLatino } : {}) });
          continue;
        }
      }
      const letter = (profile || {}).coverLetterText;
      if (refusedKind === 'narrative' && letter && /\bcover(ing)? letter\b/i.test(`${d.label} ${d.placeholder} ${d.name}`)
        && (d.type === 'textarea' || d.tag === 'textarea') && !d.hasValue) {
        fills.push({ field: d, key: 'coverLetterText', value: letter, why: 'your saved cover letter' });
        continue;
      }
      if (refusedKind === 'consent' && tickConsents && d.type === 'checkbox' && !d.el?.checked) {
        fills.push({ field: d, key: 'consent', value: 'tick', why: 'you asked for consents to be ticked', choice: true });
        continue;
      }
      if (d.visible && !isHoneypot(d) && d.type !== 'submit' && d.type !== 'button') {
        skipped.push({ field: d, reason: m ? m.why : 'not a fillable field' });
      }
      continue;
    }
    // A "Full name" box on a form that already has First and Last is a
    // SIGNATURE: Oracle ends every application with "E-Signature — Full Name".
    // Typing it signs in the person's name, so like a consent it is theirs to
    // do — unless they turned on "tick consent boxes".
    if (m.key === 'fullName' && hasSplitName) {
      if (tickConsents && !d.hasValue) {
        fills.push({ field: d, key: 'fullName', value: valueFor('fullName', profile), why: 'your signature — you asked for consents to be done' });
      } else {
        skipped.push({ field: d, reason: 'your signature (your full name) — type it yourself', factKey: 'signature' });
      }
      continue;
    }
    let value = valueFor(m.key, profile);
    // One part of a date of birth split over three boxes.
    if (m.key === 'dateOfBirth') {
      const part = birthPart(d);
      if (part) value = birthValue(part, profile);
    }
    if (value === undefined || value === null || value === '') {
      skipped.push({ field: d, reason: `nothing in your profile for ${m.key}`, factKey: m.key });
      continue;
    }
    const usedKey = m.key === 'dateOfBirth' ? `dateOfBirth:${birthPart(d) || 'whole'}` : m.key;
    // Lever asks "Portfolio URL" and then "Other website": the second takes
    // GitHub when that is saved and has no box of its own.
    if (m.key === 'website' && used.has('website') && (profile || {}).github && !used.has('github')
      && !descriptors.some((x) => matchField(x)?.key === 'github')) {
      used.add('github');
      fills.push({ field: d, key: 'github', value: profile.github, why: 'a second website box — your GitHub' });
      continue;
    }
    if (used.has(usedKey) && !['resume', 'fullName', 'location'].includes(m.key)) {
      skipped.push({ field: d, reason: 'already filled above' });
      continue;
    }
    // A COUNTRY THE SITE CHOSE. Oracle opens its form with Country = the
    // employer's own ("Italy") and the phone code +39, and leaving "a value
    // already there" alone sent every applicant's address as Italian. A country
    // box, on a fresh form, holding a country that is not yours was put there
    // by the site — it is replaced, and the panel says what it replaced.
    let replaces = '';
    if (d.hasValue && (m.key === 'country' || m.key === 'phoneCountry')) {
      const now = currentText(d);
      if (sameCountry(now, value)) {
        skipped.push({ field: d, reason: 'set to your country' });
        continue;
      }
      replaces = now;
    }
    if (d.hasValue && !replaces && !isSitePrefill(d)) {
      // Shown on the panel rather than silently accepted: the value may be the
      // person's own, or the site's wrong guess about where they live.
      skipped.push({ field: d, reason: alreadyReason(d) });
      continue;
    }
    used.add(usedKey);
    // A PLACE SEARCH for the street address (Teamtailor: "Start typing your
    // address"). The street alone brought up streets in Saudi Arabia and
    // California; the whole address brings up the right one, and only a PICKED
    // suggestion fills the city, postcode and country behind it.
    if (m.key === 'address' && looksLikeSearch(d)) {
      const p = profile || {};
      const full = [p.address, p.city, p.region, p.postcode, p.country].filter(Boolean).join(', ');
      fills.push({ field: d, key: m.key, value: full, why: m.why, lookup: true, fallback: [p.address, p.city].filter(Boolean).join(', ') });
      continue;
    }
    if (replaces) {
      fills.push({ field: d, key: m.key, value, why: `${m.why}; replaced the site's "${replaces}"` });
      continue;
    }
    if (m.key === 'phone' && codePickerBeside(descriptors)) {
      const national = nationalNumber(value, (profile || {}).country);
      if (national) {
        fills.push({ field: d, key: m.key, value: national, why: `${m.why}; without the country code, which has its own box` });
        continue;
      }
    }
    // A narrower second try for places. Lever's location box answered
    // "Toronto, Ontario, Canada" with "No location found", while its own
    // suggestions accept "Toronto" — measured 17 Sep 2026.
    const fallback = m.key === 'location' ? (profile || {}).city : undefined;
    fills.push({ field: d, key: m.key, value, why: m.why, ...(fallback && fallback !== value ? { fallback } : {}) });
  }
  // The country before the state: a state menu lists the chosen country's
  // states (BambooHR's lists US states until the country changes). And the
  // phone's country code before the number: Workable's intl-tel-input empties
  // the number when its flag changes, so a number typed first was wiped.
  const first = (f) => (f.key === 'country' ? 0 : f.key === 'phoneCountry' ? 1 : 2);
  fills.sort((a, b) => first(a) - first(b));
  return { fills, skipped };
}


/**
 * A detail asked as round buttons or tick boxes: "Title" with Mr. / Ms. /
 * Dr., "Marital status" with Single / Married. Only details that are a CHOICE
 * among words; never a name or a number.
 */
function factForGroup(question, profile) {
  const d = { label: question, placeholder: '', id: '', name: '', data: '', type: 'combobox', tag: 'select', role: 'combobox', auto: '', visible: true };
  const m = matchFieldRaw(d);
  if (!m || !['salutation', 'maritalStatus', 'gender'].includes(m.key)) return null;
  const value = valueFor(m.key, profile);
  return value ? { key: m.key, value } : null;
}

/** "Year", "Month" or "Day" when a date-of-birth box is only that part. */
function birthPart(d) {
  const words = `${d.label} ${d.placeholder} ${d.id} ${d.name}`;
  if (/(^|[^a-z])(day|dd)([^a-z]|$)/i.test(words) && !/(month|year)/i.test(d.label)) return 'day';
  if (/(^|[^a-z])(month|mm)([^a-z]|$)/i.test(words) && !/year/i.test(d.label)) return 'month';
  if (/(^|[^a-z])(year|yyyy)([^a-z]|$)/i.test(words)) return 'year';
  return null;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * That part, from the full date saved in options. The YEAR may come from a
 * saved year of birth alone; a month or a day is never made up.
 */
function birthValue(part, profile) {
  const p = profile || {};
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p.dateOfBirth || ''));
  if (part === 'year') return m ? m[1] : String((p.answers || {}).yearOfBirth || '').trim();
  if (!m) return '';
  return part === 'month' ? MONTH_NAMES[Number(m[2]) - 1] : String(Number(m[3]));
}

/**
 * Your own question/answer pairs, for what no built-in list can predict.
 *
 * Employers ask things nobody could put in a shipped list: "Do you have
 * hands-on experience with MT4 and MT5?", "This is a fixed term contract role —
 * is that acceptable?". A pair is a few words to look for and the answer to
 * give, and the longest matching phrase wins so a specific pair beats a vague
 * one.
 */
export function matchCustom(text, profile) {
  const pairs = (profile || {}).customAnswers || [];
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack.trim()) return null;
  let best = null;
  for (const pair of pairs) {
    const needle = String(pair?.match ?? '').trim().toLowerCase();
    const answer = String(pair?.answer ?? '').trim();
    if (!needle || !answer) continue;
    if (!haystack.includes(needle)) continue;
    if (!best || needle.length > best.match.length) best = { match: pair.match, answer };
  }
  return best;
}


/**
 * The answer for a question, including the ones worked out from others.
 *
 * "Eligible to work without sponsorship?" is not something anyone types in: it
 * follows from being authorised and not needing sponsorship. See answers.js.
 */
function savedAnswerFor(field, answers, question = '') {
  if (typeof field.derive === 'function') return field.derive(answers, question);
  return answers[field.key];
}

/** An option's own words: "Yes", "No", "I am legally authorised…". */
function optionText(d) {
  const own = d.label || '';
  // The group's question is often folded into each option's label by the
  // ancestor search, so take the last part, which is the option itself.
  const parts = own.split('|').map((x) => x.trim()).filter(Boolean);
  return (parts[parts.length - 1] || own || d.el?.value || '').trim();
}

/**
 * Radio and checkbox groups, with the question that governs them.
 *
 * Ashby asks work authorisation as four radios whose labels are whole sentences
 * ("I am legally authorised to work and will not require employer sponsorship
 * now or in the future"); Greenhouse asks the same thing as a dropdown. Both
 * must end up answered from one saved yes/no.
 */
export function groupChoices(descriptors) {
  const groups = new Map();
  const lists = new Map();
  for (const d of descriptors) {
    if (d.type !== 'radio' && d.type !== 'checkbox') continue;
    if (isHoneypot(d)) continue;
    // "I agree to the privacy notice" is a statement of its own even beside
    // another one; grouping consents under their heading would lose them.
    if (d.type === 'checkbox' && refusalFor(d) === 'consent') continue;
    // Radios share a name by definition. Tick boxes do not: Ashby names each one
    // after its OPTION ("White", "Veteran"), so grouping them by name made every
    // option its own one-box "question". They belong to the question above them.
    //
    // But only boxes that sit TOGETHER, in a list of tick boxes and nothing
    // else. BambooHR ends a form with seven separate declarations — "I
    // completed this application myself. All statements in it are truthful…" —
    // each its own tick box; grouped under the question above them, a saved
    // "Yes" to "Are you 18 or older?" ticked a declaration.
    if (d.type === 'checkbox' && d.buttons) continue;
    let key;
    if (d.type === 'checkbox') {
      const list = checkboxList(d.el);
      if (!list) continue;
      if (!lists.has(list)) lists.set(list, `list:${lists.size}`);
      key = lists.get(list);
    } else {
      key = d.name || `group:${questionFor(d)}`;
    }
    if (!groups.has(key)) groups.set(key, { question: questionFor(d), members: [] });
    groups.get(key).members.push(d);
  }
  const out = [...groups.values()].filter((g) => g.members.length > 1 || g.members[0].type === 'radio');
  for (const g of out) g.required = g.members.some((m) => m.required) || /[*✱]/.test(g.question);
  // The question may be written above the whole group and tied to it by
  // nothing (Rippling: <p>Are you currently located in the job location, or
  // are you willing to relocate?</p> beside a role="radiogroup"). When the
  // words found are only an option's own, the words above the group are used.
  for (const g of out) {
    const options = g.members.map((m) => optionText(m).toLowerCase());
    if (g.question.length > 12 && !options.includes(g.question.toLowerCase())) continue;
    const top = commonAncestor(g.members.map((m) => m.el).filter(Boolean));
    const above = top ? textBefore(top) : '';
    if (above) g.question = above;
  }
  return out;
}

/**
 * The list a tick box belongs to: its nearest ancestor holding more than one
 * tick box — if that ancestor holds only tick boxes. Null for a statement that
 * stands alone.
 */
function checkboxList(el) {
  if (!el || !el.parentElement) return null;
  for (let node = el.parentElement, hops = 0; node && hops < 8; node = node.parentElement, hops++) {
    const ticks = node.querySelectorAll('input[type=checkbox]').length;
    if (ticks < 2) continue;
    const other = node.querySelector('input:not([type=checkbox]):not([type=hidden]), select, textarea, [role="combobox"]');
    return other ? null : node;
  }
  return null;
}

function commonAncestor(els) {
  if (!els.length) return null;
  let node = els[0].parentElement;
  while (node && !els.every((e) => node.contains(e))) node = node.parentElement;
  return node;
}

/** The question a choice belongs to: its fieldset legend, or the words above it. */
function questionFor(d) {
  const el = d.el;
  if (!el) return d.label || '';
  const fieldset = el.closest('fieldset');
  const legend = fieldset?.querySelector('legend');
  if (legend?.textContent?.trim()) return legend.textContent.replace(/\s+/g, ' ').trim();
  const grouped = el.closest('[role="radiogroup"], [role="group"]');
  const labelledBy = grouped?.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  if (grouped?.getAttribute('aria-label')) return grouped.getAttribute('aria-label');
  // Walk up until a block holds more than the options themselves, and take its
  // first heading-like line.
  let node = el.parentElement;
  // A label that belongs to an OPTION is not the question, however long it is:
  // Ashby's "Person with disability" is one tick box's own label, and taking it
  // as the question turned each option into a question of its own.
  const isOptionLabel = (node) => {
    if (node.tagName !== 'LABEL') return false;
    if (node.querySelector('input[type=radio], input[type=checkbox]')) return true;
    const target = node.htmlFor ? el.ownerDocument.getElementById(node.htmlFor) : null;
    return Boolean(target && (target.type === 'radio' || target.type === 'checkbox'));
  };
  for (let hops = 0; node && hops < 6; hops++, node = node.parentElement) {
    for (const heading of node.querySelectorAll('legend, h1, h2, h3, h4, label, p')) {
      if (isOptionLabel(heading)) continue;
      const text = heading.textContent?.replace(/\s+/g, ' ').trim();
      if (text && text.length > 12) return text;
      // Ashby's "Gender" is six letters and the whole question.
      if (text && text.length >= 3 && /^(LABEL|LEGEND|H1|H2|H3|H4)$/.test(heading.tagName)) return text;
      break;
    }
  }
  return d.label || '';
}

/** What a box shows now: typed text, a chosen option, or a menu's words. */
function currentText(d) {
  const el = d.el || {};
  if (d.tag === 'select') return (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '') || menuText(el);
  if (d.type === 'combobox' && d.tag !== 'input') return (el.textContent || '').trim();
  return String(el.value || '').trim();
}

/** "United States" and "USA", "India" and "India (+91)" — the same country. */
function sameCountry(shown, saved) {
  const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z+0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = flat(shown);
  if (!a) return false;
  return choiceWords(saved).map(flat).filter(Boolean).some((w) => a === w || new RegExp(`(^|[^a-z])${w.replace(/[+]/g, '\\+')}([^a-z]|$)`).test(a));
}

/** A box that searches as you type rather than taking text as it is. */
function looksLikeSearch(d) {
  const el = d.el || {};
  return d.role === 'combobox'
    || (el.getAttribute && (el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('aria-haspopup') === 'listbox'))
    || /start typing|search/i.test(d.placeholder);
}

/** Profile → the string this field wants. */
export function valueFor(key, profile) {
  const p = profile || {};
  const job = (p.experience || [])[0] || {};
  const school = (p.education || [])[0] || {};
  switch (key) {
    case 'currentCompany':
      return p.currentCompany || job.company || '';
    case 'currentTitle':
      return p.currentTitle || job.title || '';
    case 'school':
      return school.school || '';
    case 'degree':
      return school.degree || '';
    case 'discipline':
      return school.discipline || '';
    case 'gpa':
      return school.gpa || '';
    case 'graduationYear':
      return String(school.end || '').slice(0, 4);
    case 'skills':
      return Array.isArray(p.skills) ? p.skills.join(', ') : p.skills || '';
    case 'coverLetter':
      return p.coverLetter ? p.coverLetter.name : '';
    case 'jobDescription':
      return job.description || '';
    case 'eduDescription':
      return school.description || '';
    case 'eduStart':
      return school.start || '';
    case 'eduEnd':
      return school.end || '';
    case 'jobStart':
      return job.start || '';
    case 'jobEnd':
      return job.current ? '' : job.end || '';
    case 'confirmEmail':
      return p.email || '';
    case 'phoneCountry':
      return p.country || '';
    case 'password':
    case 'passwordConfirm':
      return p.accountPassword || '';
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
