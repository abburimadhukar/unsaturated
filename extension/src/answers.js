/**
 * The questions employers ask beyond name and email — and your own answers.
 *
 * WHY THESE ARE NOT FILLED FROM GUESSWORK
 *
 * "Will you now or in the future require sponsorship?" has a right answer and a
 * wrong one, and the wrong one is a lie told in your name. So the extension
 * never infers these: it fills them ONLY from an answer you typed into the
 * options page yourself, and the panel says which ones came from there so you
 * can check them before submitting. An answer you have not saved is left blank
 * and listed, never invented.
 *
 * ONE LIST, TWO JOBS. Everything below drives both the options page (the fields
 * you fill in) and the matcher (what each employer question maps to). A question
 * type that exists in one and not the other is the classic way autofill starts
 * filling the wrong box, so there is only one list.
 *
 * `choice` answers are yes/no. `text` answers are short. The wording employers
 * use is captured in `re`, taken from the live forms surveyed on 17–18 September
 * 2026 (Greenhouse, Lever, Ashby, Workable, Rippling, BambooHR, Personio,
 * Recruitee, Teamtailor, Breezy, Eightfold, Oracle).
 */

export const ANSWER_FIELDS = [
  // ---- work eligibility ------------------------------------------------
  // A COMBINED QUESTION, AND THE REASON THIS EXISTS.
  //
  // Globalization Partners asks, on a live Greenhouse form: "Are you currently
  // eligible to work in the country where this role is posted WITHOUT visa
  // sponsorship?" It contains the word "sponsorship", so the sponsorship rule
  // claimed it and answered "No" — from an answer meaning "I do not need
  // sponsorship". The form was told the opposite of the truth.
  //
  // It is not stored; it is worked out from the two answers that are, and only
  // when both are known. "Yes" requires being authorised AND needing no
  // sponsorship; anything else is "No".
  {
    key: 'authorisedWithoutSponsorship',
    type: 'choice',
    derived: true,
    label: 'Eligible to work without sponsorship (worked out from the two answers below)',
    re: /\b(eligible|authoris\w*|authoriz\w*|able|permitted)\b[^?]*\bwithout\b[^?]*\bsponsor\w*/i,
    derive(answers = {}) {
      const authorised = answers.workAuthorised;
      const sponsorship = answers.needsSponsorship;
      if (!authorised || !sponsorship) return '';
      return isYes(authorised) && !isYes(sponsorship) ? 'Yes' : 'No';
    },
  },
  {
    key: 'workAuthorised',
    type: 'choice',
    label: 'Are you legally authorised to work where you apply?',
    help: 'Answers "are you legally authorized to work in …", "do you have the right to work in …".',
    // JazzHR: "Are you legally eligible to be employed in the United States?"
    re: /\b(legally\s+)?(authori[sz]ed|authorisation|authorization|eligible|entitled|permitted)\b.*\b(work|employment|employed)\b|\bright to work\b|\bwork (permit|eligibility|authorisation|authorization)\b/i,
    // Narrow on purpose. An earlier version refused anything containing "which"
    // or "describe", which threw away Ashby's actual question — "Which of the
    // following best describes your right to work in the country where this role
    // is based?" — and left the whole group unanswered.
    not: /\b(provide|state|share|give)\b.*\bdetails\b|\bvisa (type|number|status)\b|\bexpiry\b/i,
  },
  {
    key: 'needsSponsorship',
    type: 'choice',
    label: 'Will you need visa sponsorship?',
    help: 'Answers "will you now or in the future require sponsorship?". Note the question is usually asked the other way round from the one above.',
    re: /\bsponsor\w*\b|\brequire\b.*\b(visa|work permit)\b/i,
    // Same narrowing as above: refuse only the free-text "give details" forms.
    not: /\b(provide|state|share|give)\b.*\bdetails\b|\bwhat type of (visa|permit)\b/i,
  },
  {
    key: 'visaDetails',
    type: 'text',
    label: 'Your work-authorisation details',
    help: 'Free text for "provide details of your current work authorisation", visa type, expiry.',
    re: /\b(visa|work authori[sz]ation|work permit|immigration)\b.*\b(details|status|type|expiry|explain|describe)\b|\bdetails of your\b.*\b(work|visa)\b/i,
  },
  {
    key: 'nationality',
    type: 'text',
    label: 'Nationality / citizenship',
    re: /\bnationalit(y|ies)\b|\bcitizenship\b|\bcountry of citizenship\b/i,
  },
  {
    key: 'over18',
    type: 'choice',
    label: 'Are you 18 or older?',
    // JazzHR: "Are you over the age of 18?" — the age after the words.
    // Ford asks it without naming an age: "Do you meet the legal minimum age
    // requirement for the location of the position in which you are applying?"
    re: /\b(18|eighteen|sixteen|16)\b.*\b(or older|years of age|age)\b|\bof legal working age\b|\b(over|above|at least) (the age of )?(18|eighteen)\b|\bage of (18|eighteen)\b|\b(legal )?minimum age requirement\b|\bmeet the (legal )?minimum age\b/i,
  },
  // ---- logistics -------------------------------------------------------
  {
    key: 'noticePeriod',
    type: 'text',
    label: 'Notice period',
    help: 'For example "4 weeks", "immediately available".',
    re: /\bnotice period\b|\bhow (much|long) notice\b/i,
  },
  {
    key: 'earliestStart',
    type: 'text',
    label: 'Earliest start date',
    help: 'For example "1 November 2026" or "immediately".',
    // Recruitee: "When are you available to start working?"; JazzHR: "When
    // would you be available to begin work?".
    re: /\b(start date|available from|availability|date available|earliest.*(start|available)|when can you (start|begin|join)|available to (start|begin|commence|join)|when (are you|would you be|will you be) available)\b/i,
  },
  {
    key: 'willingToRelocate',
    type: 'choice',
    label: 'Are you willing to relocate?',
    re: /\brelocat\w*\b/i,
  },
  {
    key: 'workPreference',
    type: 'text',
    label: 'Remote / hybrid / on-site preference',
    re: /\b(remote|hybrid|on-?site|work (from home|arrangement|preference|model|setup))\b/i,
    not: /location|city|country|address/i,
  },
  // Rippling asks both, one after the other: willing to relocate, and then
  // "Will you require relocation assistance?" — a different answer.
  {
    key: 'relocationAssistance',
    type: 'choice',
    label: 'Would you need relocation assistance?',
    re: /\brelocation (assistance|support|package|help|costs?)\b|\b(assist\w*|help|support) (with|in) (your )?relocat\w*/i,
  },
  // Personio: "Desired location to work from" — where you WANT to work, not
  // where you live.
  {
    key: 'preferredLocation',
    type: 'text',
    label: 'Where would you like to work? (city, or "Remote")',
    re: /\b(desired|preferred)\b.{0,20}\b(work )?location\b|\blocation\b.{0,20}\b(preference|to work from)\b|\bwhere would you (like|prefer) to (work|be based)\b/i,
  },
  {
    key: 'commutable',
    type: 'choice',
    label: 'Can you commute to the job’s location?',
    re: /\bcommut\w*\b|\bable to (travel|attend) the office\b/i,
  },
  // ---- money -----------------------------------------------------------
  {
    key: 'salaryExpectation',
    type: 'text',
    label: 'Salary expectation',
    help: 'Whatever you would type yourself — a number, a range, or "open to discussion".',
    re: /\b(salary|compensation|pay|remuneration|package)\b.*\b(expect\w*|requirement|desired|range|target|minimum)\b|\b(minimum|base|desired|target) (salary|compensation|pay)\b|\bdesired (pay|salary)\b|\bexpected (salary|ctc|compensation)\b|\bwhat.*your.*(salary|rate)\b/i,
    not: /current|previous|last drawn/i,
  },
  // ---- experience ------------------------------------------------------
  // "Do you have 10+ years of experience?" as a yes/no. Worked out from your
  // saved number — and only for experience IN GENERAL: "10+ years of
  // experience in Salesforce" is a claim about one tool that your total years
  // cannot make, so that one is left for you.
  {
    key: 'yearsAtLeast',
    type: 'choice',
    derived: true,
    label: 'At least N years of experience? (worked out from your years of experience)',
    re: /\b(do|have|are) you\b[^?]*?\b\d+\s*\+?\s*(or more |plus )?(years|yrs)\b[^?]*?\bexperience\s*(\?|$)/i,
    derive(answers = {}, question = '') {
      const have = parseFloat(String(answers.yearsExperience || '').replace(/[^\d.]/g, ''));
      const need = parseFloat((/(\d+)\s*\+?\s*(or more |plus )?(years|yrs)/i.exec(question) || [])[1]);
      if (!Number.isFinite(have) || !Number.isFinite(need)) return '';
      return have >= need ? 'Yes' : 'No';
    },
  },
  {
    key: 'yearsExperience',
    type: 'text',
    label: 'Years of relevant experience',
    help: 'A single number. Employers ask this constantly.',
    re: /\b(years|yrs)\b.*\bexperience\b|\bexperience\b.*\b(years|yrs)\b|\bhow many years\b/i,
  },
  {
    key: 'education',
    type: 'text',
    label: 'Highest qualification',
    help: 'For example "BSc Computer Science, University of Toronto, 2019".',
    re: /\b(highest )?(degree|qualification|education level|level of education|university|college|graduation)\b|\bhighest (level of )?education\b/i,
    not: /school name only/i,
  },
  // Personio asks "English language skills" as a menu of A1 … C2; a sentence
  // such as "English (native), French (basic)" matches none of those. One
  // level, in the words such menus use, answers them.
  {
    key: 'englishLevel',
    type: 'text',
    label: 'Your English level',
    help: 'As menus word it: "C2", "C1", "B2" (the European scale), or "Native" / "Fluent".',
    re: /\benglish\b.*\b(level|skills?|proficiency|fluency)\b|\b(level|proficiency) (of|in) english\b|\bhow well do you speak english\b/i,
  },
  {
    key: 'languages',
    type: 'text',
    label: 'Languages you speak',
    re: /\blanguages?\b.*\b(speak|skills|proficiency|fluent)\b|\b(english|german|french) (language )?(skills|level|proficiency)\b/i,
  },
  {
    key: 'currentSalary',
    type: 'text',
    label: 'Current salary (only if you are willing to give it)',
    help: 'Employers do ask. Leave blank and every such box is left for you — several US states ban the question outright.',
    re: /\bcurrent\b.*\b(salary|pay|compensation|ctc)\b|\blast drawn\b|\bpresent salary\b/i,
  },
  {
    key: 'yearOfBirth',
    type: 'text',
    sensitive: true,
    label: 'Year of birth',
    help: 'Asked by some European employers. Blank means it is left for you.',
    re: /\b(year of birth|date of birth|birth year|geburtsjahr)\b/i,
  },
  {
    key: 'workedHereBefore',
    type: 'choice',
    label: 'Have you worked for this employer before?',
    // Real wordings only. The looser "employee … here" matched Ashby's "If
    // referred by an IRIS employee, please share their name." through its
    // placeholder "Type here...", and put "No" into a name box.
    re: /\bhave you (ever )?(previously )?(worked|been employed)\b|\b(previously|formerly) (worked|been employed|employed)\b|\bformer (employee|staff)\b|\bre-?hire\b|\bworked (here|for us|with us)\b/i,
    // JazzHR: "Have you ever worked under another name?" asks about a NAME.
    not: /\b(another|other|different|previous|maiden) name\b/i,
  },
  {
    key: 'appliedBefore',
    type: 'choice',
    label: 'Have you applied to this employer before?',
    re: /\b(previously|ever|already|have you) applied\b|\bapplied\b.*\b(before|previously|in the past)\b/i,
  },
  {
    key: 'currentlyEmployed',
    type: 'choice',
    label: 'Are you currently employed?',
    help: 'Filled from your résumé when a job there runs to "Present".',
    re: /\b(currently|presently) (employed|working)\b|\bare you (currently |presently )?employed\b|\bemployment status\b/i,
    not: /\b(here|with us|by us|at this company)\b/i,
  },
  {
    key: 'mayContactEmployer',
    type: 'choice',
    label: 'May they contact your current employer?',
    help: 'Answers "if you are employed, may we contact / inquire of your present employer?".',
    re: /\b(may|can|could) we (contact|inquire( of)?|reach out to|speak (to|with)|ask)\b.*\bemployer\b|\bcontact your (current|present) employer\b|\bpermission to contact\b.*\bemployer\b/i,
  },
  {
    key: 'futureOpportunities',
    type: 'choice',
    label: 'May they consider you for other or future roles?',
    help: 'Answers "may we keep your résumé on file / consider you for future positions?". Never ticks a marketing or newsletter box.',
    re: /\b(future|other|similar) (roles?|positions?|opportunities|openings|vacancies|projects|jobs)\b|\bkeep (your|my) (cv|resume|résumé|details|application|information) on file\b|\bconsider(ed)? (you|me) for (other|future)\b/i,
    not: /\bnewsletter|marketing|subscribe|job alerts?\b/i,
  },
  {
    key: 'relativeAtCompany',
    type: 'choice',
    label: 'Do you have relatives working for the employer?',
    re: /\b(relative|relatives|family member|related to)\b.*\b(work|works|working|employ\w*|company|organi[sz]ation)\b/i,
  },
  {
    key: 'nonCompete',
    type: 'choice',
    label: 'Are you bound by a non-compete or non-solicitation agreement?',
    re: /\bnon-?compete\b|\bnon-?solicit\w*\b|\brestrictive covenant/i,
  },
  {
    key: 'backgroundCheck',
    type: 'choice',
    label: 'Willing to undergo a background check / drug screen?',
    re: /\bbackground (check|screening|verification|investigation)\b|\bdrug (test|screen\w*)\b/i,
  },
  {
    key: 'driversLicense',
    type: 'choice',
    label: 'Do you hold a valid driving licence?',
    re: /\bdriv(er'?s?|ing) licen[cs]e\b|\bvalid licen[cs]e to drive\b/i,
  },
  {
    key: 'willingToTravel',
    type: 'text',
    label: 'Willing to travel? (Yes / No / e.g. "up to 25%")',
    re: /\b(willing|able|comfortable|open)\b.*\btravel\b|\btravel (requirement|up to|percentage)\b|\bhow much travel\b/i,
    not: /\boffice\b|\bcommut/i,
  },
  {
    key: 'securityClearance',
    type: 'text',
    label: 'Security clearance',
    help: 'For example "None", "Secret (active)", "SC", "DV". Blank leaves every such question for you.',
    re: /\bsecurity clearance\b|\bclearance (level|status)\b|\b(active|current|hold an?) clearance\b/i,
  },
  {
    key: 'timezone',
    type: 'text',
    label: 'Your time zone',
    help: 'For example "EST (UTC−5)" or "IST".',
    re: /\btime ?zone\b/i,
  },
  // ---- how they heard --------------------------------------------------
  {
    key: 'howDidYouHear',
    type: 'text',
    label: 'How did you hear about this job?',
    re: /\bhow did you (hear|find|learn)\b|\bwhere did you (hear|find|see)\b|\bsource\b.*\bapplication\b|\breferral source\b/i,
  },
  // TWO QUESTIONS, NOT ONE. "Have you been referred by an employee?" is a
  // yes/no, and was the commonest required box left empty in the live runs —
  // because the only saved answer was the referrer's NAME, which is rightly
  // blank for most people. A blank name cannot mean "No"; a saved "No" can.
  {
    key: 'wasReferred',
    type: 'choice',
    label: 'Were you referred by someone who works there?',
    help: 'Usually "No". Answers "have you been referred by an employee?".',
    re: /\b(have|were|are) you (been |being )?referred\b|\breferred by (an?|another|one of our|a current) \w*\s*(employee|team member|staff)\b|\bemployee referral\?/i,
    not: /\b(name|who|whom|please (state|provide|share)|if (yes|so))\b/i,
  },
  {
    key: 'referredBy',
    type: 'text',
    label: 'Who referred you (if anyone)',
    help: 'Their name. Leave blank if nobody did — a blank answer is never filled in.',
    re: /\brefer(red|ral)\b.*\b(by|employee|name|who)\b|\bwho referred you\b|\bemployee referral\b/i,
  },
  // ---- sensitive -------------------------------------------------------
  // Filled only when you have typed something here. Every one of these is
  // voluntary on the employer's form too: "Decline to answer" is a real answer
  // and the one these default to by being blank.
  {
    key: 'hispanicLatino',
    type: 'choice',
    sensitive: true,
    label: 'Are you Hispanic or Latino?',
    help: 'US forms ask this apart from race. Blank leaves it for you.',
    re: /\bhispanic\b|\blatin[oax]\b/i,
    // "Race / ethnicity (Hispanic or Latino, White, …)" is the race question.
    not: /\brace\b|\bethnicit/i,
  },
  {
    key: 'sexualOrientation',
    type: 'text',
    sensitive: true,
    label: 'Sexual orientation',
    re: /\bsexual orientation\b/i,
  },
  {
    key: 'transgender',
    type: 'choice',
    sensitive: true,
    label: 'Do you identify as transgender?',
    re: /\btransgender\b|\btrans (identity|experience)\b/i,
  },
  {
    key: 'lgbtq',
    type: 'choice',
    sensitive: true,
    label: 'Do you identify as LGBTQ+?',
    re: /\blgbt\w*\+?|\bqueer\b/i,
  },
  // Ashby: "Which of the following communities do you belong to? Please select
  // all that apply." — Person with disability / Neurodiverse / Veteran /
  // Parent / Refugee or immigrant / None of the above / I prefer not to answer.
  {
    key: 'communities',
    type: 'text',
    sensitive: true,
    label: 'Communities you belong to',
    help: 'For "which of these communities do you belong to? (select all that apply)". Several answers separated by commas, or "None of the above" / "Prefer not to say".',
    re: /\bcommunit(y|ies)\b.*\b(belong|identify|part of|member)\b|\b(belong to|identify with|part of) (any of )?(the following|these) (groups|communities)\b/i,
  },
  {
    key: 'gender',
    type: 'text',
    sensitive: true,
    label: 'Gender',
    help: 'Blank means the extension leaves every gender question for you.',
    re: /\bgender\b|\bsex\b(?!ual orientation)/i,
  },
  { key: 'pronouns', type: 'text', sensitive: true, label: 'Pronouns', re: /\bpronouns?\b/i },
  {
    key: 'ethnicity',
    type: 'text',
    sensitive: true,
    label: 'Race / ethnicity',
    re: /\b(race|ethnic\w*|hispanic|latino)\b/i,
  },
  {
    key: 'veteranStatus',
    type: 'text',
    sensitive: true,
    label: 'Veteran status',
    re: /\bveteran\b|\bmilitary service\b|\bprotected veteran\b/i,
  },
  {
    key: 'disabilityStatus',
    type: 'text',
    sensitive: true,
    label: 'Disability status',
    re: /\bdisabilit\w*\b|\bdisabled\b/i,
  },
];

/** Yes/no in the words forms actually use. */
const YES = /^(yes|y|true|i am|i do|✓)$/i;
const NO = /^(no|n|false|i am not|i do not|none)$/i;

/**
 * "I would rather not say", in every wording the forms use.
 *
 * Measured on live forms: Greenhouse offers "I don't wish to answer", Workday
 * "I do not wish to self-identify", others "Decline to self identify" or
 * "Prefer not to disclose". Someone who saved "Prefer not to say" means all of
 * them, and matching only the exact words left those boxes empty.
 *
 * Deliberately NOT mapped: Personio's gender list of Male / Female / Diverse /
 * Undefined has no decline option, and picking "Undefined" on someone's behalf
 * would be answering a question they chose not to answer. That one is reported.
 */
const DECLINE = /^(prefer not|rather not|decline|do ?n[o']?t (wish|want)|not disclos|no answer|undisclosed)/i;

/** Turns a stored answer into the option text a form expects. */
export function choiceWords(value) {
  const v = String(value ?? '').trim();
  if (YES.test(v)) return ['yes', 'y', 'true', 'i am', 'i do', 'i am legally authorised', 'authorized'];
  if (NO.test(v)) return ['no', 'n', 'false', 'i am not', 'i do not', 'none', 'not required'];
  if (DECLINE.test(v)) {
    return [
      v.toLowerCase(),
      'prefer not to say', 'prefer not to answer', 'prefer not to disclose',
      "i don't wish to answer", 'i do not wish to answer',
      'i do not wish to self-identify', "i don't wish to self-identify",
      'decline to self identify', 'decline to self-identify', 'decline to answer',
      'not disclosed', 'choose not to disclose',
    ];
  }
  // Ashby's gender question offers Man / Woman / Non-Binary; a saved "Female"
  // matched none of them and the question was left.
  const gender = GENDER_WORDS.find((g) => g.re.test(v));
  if (gender) return [v.toLowerCase(), ...gender.words.filter((w) => w !== v.toLowerCase())];
  const country = countryWords(v);
  if (country.length) return [v.toLowerCase(), ...country.filter((w) => w !== v.toLowerCase())];
  const degree = degreeWords(v);
  if (degree.length) return [v.toLowerCase(), ...degree];
  return [v.toLowerCase()];
}

const GENDER_WORDS = [
  { re: /^(female|woman|women|f|cis(gender)? woman)$/i, words: ['female', 'woman', 'women', 'cisgender woman', 'cis woman'] },
  { re: /^(male|man|men|m|cis(gender)? man)$/i, words: ['male', 'man', 'men', 'cisgender man', 'cis man'] },
  { re: /^(non-?binary|non binary|nb|genderqueer)$/i, words: ['non-binary', 'nonbinary', 'non binary', 'genderqueer'] },
];

/** Words compared as a person reads them: "don’t" is "do not", "I'm" is "I am". */
export function plainWords(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/\bdon't\b/g, 'do not').replace(/\bdoesn't\b/g, 'does not').replace(/\bi'm\b/g, 'i am')
    .replace(/\bhaven't\b/g, 'have not').replace(/\bwon't\b/g, 'will not').replace(/\baren't\b/g, 'are not')
    .replace(/\s+/g, ' ').trim();
}

/**
 * What an answer MEANS, when it is a yes, a no or a decline however it is
 * worded. Rippling's disability menu says "No, I don't have a disability and
 * have not had one in the past"; a saved "No, I do not have a disability" is the
 * same answer and matched none of it word for word.
 */
export function meaningOf(value) {
  const v = plainWords(value);
  if (!v) return null;
  if (/\b(prefer not|rather not|decline|do not wish|do not want to (answer|disclose|say|identify|self)|not to (answer|say|disclose|self)|choose not|wish not|no answer|not disclos\w*|undisclosed|self-? ?identify)\b/.test(v)) return 'decline';
  if (/^(no|none|not|never|n)\b|\b(i am not|i do not|do not have|have not|not a (protected )?veteran|am not a)\b/.test(v)) return 'no';
  if (/^(yes|y)\b|\b(i am|i have|i identify as (a |one )|i do)\b/.test(v)) return 'yes';
  return null;
}

/**
 * Which of a question's options is the saved answer: in its own words first,
 * then in its other wordings, then — only when exactly one option means the
 * same yes, no or decline — by meaning. -1 when none is.
 *
 * Whole words only, and never a single letter: "Yes" once matched "I completed
 * this application mYself…" through the one-letter spelling "y".
 */
export function pickOption(options, saved) {
  const texts = options.map(plainWords);
  const wanted = choiceWords(saved).map(plainWords).filter(Boolean);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const starts = (t, w) => t === w || (w.length >= 2 && new RegExp(`^${esc(w)}($|[^a-z0-9])`).test(t));
  const inside = (t, w) => w.length >= 3 && new RegExp(`(^|[^a-z0-9])${esc(w)}($|[^a-z0-9])`).test(t);
  for (const test of [(t, w) => t === w, starts, inside]) {
    for (const w of wanted) {
      const i = texts.findIndex((t) => test(t, w));
      if (i >= 0) return i;
    }
  }
  const band = bandFor(options, saved);
  if (band >= 0) return band;
  const meaning = meaningOf(saved);
  if (meaning) {
    const same = texts.map((t, i) => (meaningOf(t) === meaning ? i : -1)).filter((i) => i >= 0);
    if (same.length === 1) return same[0];
  }
  return -1;
}

/**
 * The band a saved NUMBER falls in: Recruitee asks salary as "$110,000 -
 * $120,000" / "$120,000+" and a saved 120000 matched no words. Only for a
 * plain number with nothing else in it ("120000", "120,000", "$120k"), and only
 * when exactly one band holds it. -1 otherwise.
 */
export function bandFor(options, saved) {
  const num = (s) => {
    const m = /^\s*[$£€]?\s*(\d[\d,.]*)\s*(k)?\s*$/i.exec(String(s));
    if (!m) return NaN;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return m[2] ? n * 1000 : n;
  };
  const value = num(saved);
  if (!Number.isFinite(value)) return -1;
  const money = (t) => {
    const n = parseFloat(t.replace(/[^\d.]/g, ''));
    return /k\b/i.test(t) ? n * 1000 : n;
  };
  // Each band as [low, high]; a value ON an edge ("$120,000" with bands
  // "$110,000–$120,000" and "$120,000+") belongs to both, and is left for the
  // person rather than guessed.
  const bands = options.map((o) => {
    const t = String(o);
    const range = /([$£€]?\s*\d[\d,.]*\s*k?)\s*(?:-|–|—|to)\s*([$£€]?\s*\d[\d,.]*\s*k?)/i.exec(t);
    if (range) return [money(range[1]), money(range[2])];
    const up = /([$£€]?\s*\d[\d,.]*\s*k?)\s*(\+|or more|and above|or higher)/i.exec(t);
    if (up) return [money(up[1]), Infinity];
    const below = /(less than|under|below|up to)\s*([$£€]?\s*\d[\d,.]*\s*k?)/i.exec(t);
    if (below) return [-Infinity, money(below[2])];
    return null;
  });
  const hits = bands.map((b, i) => (b && value >= b[0] && value <= b[1] ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 1) return hits[0];
  // A LADDER of open-ended bands — Ford's "1+ years / 3+ years / 5+ years /
  // 7+ years" — is not an ambiguity: seven years meets all four, and the one
  // the person would pick is the highest they reach.
  if (hits.length > 1 && hits.every((i) => bands[i][1] === Infinity)) {
    return hits.reduce((best, i) => (bands[i][0] > bands[best][0] ? i : best), hits[0]);
  }
  return -1;
}

/**
 * A country in every form a menu writes it: its names, and its dialling code
 * for a phone-code picker. Oracle's picker lists "India", Rippling's phone menu
 * "+91 IN - India", and forms disagree about "United States" and "USA".
 */
const COUNTRIES = [
  [['united states', 'united states of america', 'usa', 'us', 'u.s.', 'america'], '+1'],
  [['canada'], '+1'], [['united kingdom', 'uk', 'great britain', 'england', 'britain'], '+44'],
  [['india'], '+91'], [['germany', 'deutschland'], '+49'], [['france'], '+33'], [['spain', 'españa'], '+34'],
  [['italy', 'italia'], '+39'], [['netherlands', 'the netherlands', 'holland'], '+31'], [['belgium'], '+32'],
  [['ireland'], '+353'], [['portugal'], '+351'], [['switzerland'], '+41'], [['austria'], '+43'],
  [['sweden'], '+46'], [['norway'], '+47'], [['denmark'], '+45'], [['finland'], '+358'], [['poland'], '+48'],
  [['australia'], '+61'], [['new zealand'], '+64'], [['singapore'], '+65'], [['malaysia'], '+60'],
  [['philippines'], '+63'], [['indonesia'], '+62'], [['japan'], '+81'], [['china'], '+86'],
  [['hong kong'], '+852'], [['south korea', 'korea'], '+82'], [['pakistan'], '+92'], [['bangladesh'], '+880'],
  [['sri lanka'], '+94'], [['nepal'], '+977'], [['united arab emirates', 'uae'], '+971'], [['saudi arabia'], '+966'],
  [['qatar'], '+974'], [['israel'], '+972'], [['turkey', 'türkiye'], '+90'], [['egypt'], '+20'],
  [['south africa'], '+27'], [['nigeria'], '+234'], [['kenya'], '+254'], [['brazil', 'brasil'], '+55'],
  [['mexico', 'méxico'], '+52'], [['argentina'], '+54'], [['colombia'], '+57'], [['chile'], '+56'],
];

export function countryWords(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return [];
  const hit = COUNTRIES.find(([names]) => names.includes(v));
  return hit ? [...hit[0], hit[1]] : [];
}

/**
 * The same degree in the words a menu uses.
 *
 * A résumé says "Master of Science"; Greenhouse's degree menu says "Master's
 * Degree", Workday's "Masters", Lever's "MS". All four are one answer, and
 * matching only the exact words left every degree menu unanswered.
 */
const DEGREE_SPELLINGS = [
  { re: /\b(ph\.?\s?d|doctor(ate)?|d\.?phil)\b/i, words: ['doctorate', 'ph.d.', 'phd', 'doctor of philosophy', 'doctoral degree'] },
  { re: /\b(m\.?b\.?a|business administration)\b/i, words: ['master of business administration (m.b.a.)', 'mba', 'm.b.a.', "master's degree", 'masters'] },
  { re: /\b(master'?s?|m\.?sc?|m\.?a\.?|m\.?tech|m\.?eng|m\.?phil|m\.?com|mca|ll\.?m)\b/i, words: ["master's degree", "master's", 'masters', 'master', 'master of science (m.s.)', 'master of arts (m.a.)', 'ms', 'ma'] },
  { re: /\b(bachelor'?s?|b\.?sc?|b\.?a\.?|b\.?tech|b\.?eng|b\.?e\.?|b\.?com|bca|bba|ll\.?b)\b/i, words: ["bachelor's degree", "bachelor's", 'bachelors', 'bachelor', 'bachelor of science (b.s.)', 'bachelor of arts (b.a.)', 'undergraduate', 'bs', 'ba'] },
  { re: /\bassociate'?s?\b/i, words: ["associate's degree", "associate's", 'associates', 'associate'] },
  { re: /\bhigh school|secondary\b/i, words: ['high school diploma', 'high school', 'high school or equivalent', 'secondary school', 'ged'] },
];

export function degreeWords(value) {
  const v = String(value ?? '');
  for (const d of DEGREE_SPELLINGS) {
    if (!d.re.test(v)) continue;
    // Science or arts, when the saved degree says which: "BSc" must find
    // "Bachelor of Science" before any menu's "Bachelor of Arts".
    const level = /master/.test(d.words[0]) ? 'master' : /bachelor/.test(d.words[0]) ? 'bachelor' : '';
    if (!level) return d.words;
    const science = /\b(science|b\.?\s?sc?|m\.?\s?sc?|b\.?s\.|m\.?s\.)\b/i.test(v);
    const arts = /\b(arts|b\.?a\.?|m\.?a\.?)\b/i.test(v) && !science;
    const engineering = /\b(engineering|b\.?\s?tech|b\.?\s?eng?|m\.?\s?tech|m\.?\s?eng)\b/i.test(v);
    const specific = [
      ...(science ? [`${level} of science`] : []),
      ...(arts ? [`${level} of arts`] : []),
      ...(engineering ? [`${level} of engineering`, `${level} of technology`] : []),
    ];
    const other = science ? /of arts/ : arts ? /of science/ : null;
    return [...specific, ...d.words.filter((w) => !(other && other.test(w)))];
  }
  return [];
}

/** True when an answer is a "rather not say", whatever the wording. */
export function isDecline(value) {
  return DECLINE.test(String(value ?? '').trim());
}

export function isYes(value) {
  return YES.test(String(value ?? '').trim());
}

/**
 * Which saved answer a question is asking for, if any.
 *
 * Order matters: sponsorship is checked before work authorisation, because
 * "Will you require sponsorship to work in the UK?" contains both ideas and only
 * one of them is the question.
 */
const ORDER = [
  'authorisedWithoutSponsorship', 'needsSponsorship', 'visaDetails', 'workAuthorised', 'nationality', 'over18',
  'wasReferred', 'referredBy', 'appliedBefore', 'workedHereBefore', 'relativeAtCompany', 'mayContactEmployer', 'futureOpportunities', 'currentlyEmployed', 'currentSalary', 'yearOfBirth',
  'howDidYouHear', 'noticePeriod', 'earliestStart', 'commutable', 'willingToTravel',
  'relocationAssistance', 'willingToRelocate', 'preferredLocation', 'workPreference', 'salaryExpectation', 'yearsAtLeast', 'yearsExperience',
  'education', 'englishLevel', 'languages', 'nonCompete', 'backgroundCheck', 'driversLicense', 'securityClearance', 'timezone',
  'communities', 'hispanicLatino', 'sexualOrientation', 'transgender', 'lgbtq',
  'gender', 'pronouns', 'ethnicity', 'veteranStatus', 'disabilityStatus',
];

const BY_KEY = new Map(ANSWER_FIELDS.map((f) => [f.key, f]));

export function matchAnswer(text) {
  // Forms type apostrophes both ways: "driver's" and "driver’s" are one word.
  const words = String(text ?? '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  if (!words) return null;
  for (const key of ORDER) {
    const field = BY_KEY.get(key);
    if (!field) continue;
    if (field.not && field.not.test(words)) continue;
    if (field.re.test(words)) return field;
  }
  return null;
}

export function answerField(key) {
  return BY_KEY.get(key) ?? null;
}
