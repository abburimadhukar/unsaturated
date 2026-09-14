/**
 * Making a rewritten resume sound like a person wrote it.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE PROMPT
 *
 * "Write naturally" does nothing. A model asked for a resume bullet reaches for
 * the same forty words every time, and the result is instantly recognisable to
 * anyone who reads CVs for a living — which, at the other end of an application,
 * is everyone. The tells are specific and they are listable, so they are listed,
 * banned by name in the prompt, and CHECKED afterwards.
 *
 * Checked afterwards because a prompt is a request. The same reasoning as the
 * fabrication check: asking the model not to do something and verifying it did
 * not are different activities, and only the second one is a property of the
 * output.
 *
 * WHAT ACTUALLY MAKES A BULLET SOUND WRITTEN
 *
 * Not vocabulary alone. Three things, in order of how loudly they give it away:
 *
 *   1. UNIFORM SHAPE. Every bullet the same length, every one opening with a
 *      past-tense verb, every one ending in a purpose clause — "…, ensuring
 *      seamless integration", "…, improving overall efficiency". A person writes
 *      some bullets short because there is not much to say.
 *
 *   2. THE PURPOSE-CLAUSE HABIT. A comma and a present participle bolted onto
 *      the end of every sentence to imply a result nobody measured. This is the
 *      single strongest tell in a tailored CV.
 *
 *   3. THE WORDS. Leveraged, spearheaded, utilised, robust, seamless, holistic.
 *      Easy to list, easiest to avoid, and the one people notice consciously.
 */

/**
 * Words that mark a sentence as machine-written, or as consultant-written, which
 * reads the same way from the other side of a desk.
 *
 * Every one of these has a shorter, plainer word that says the same thing, which
 * is why they are safe to ban outright rather than discourage.
 */
export const BANNED_WORDS = [
  'leverage', 'leveraged', 'leveraging',
  'utilise', 'utilised', 'utilize', 'utilized', 'utilizing', 'utilising',
  'spearhead', 'spearheaded', 'spearheading',
  'orchestrate', 'orchestrated', 'orchestrating',
  'robust', 'seamless', 'seamlessly', 'holistic', 'synergy', 'synergies',
  'cutting-edge', 'state-of-the-art', 'best-in-class', 'world-class',
  'passionate', 'dynamic', 'innovative', 'transformative', 'impactful',
  'delve', 'myriad', 'plethora', 'realm', 'landscape', 'tapestry',
  'showcase', 'showcased', 'showcasing',
  'streamline', 'streamlined', 'streamlining',
  'spearheading', 'facilitate', 'facilitated',
  'comprehensive', 'extensive', 'various', 'numerous',
  'ensuring', 'enabling', 'empowering', 'fostering', 'driving',
];

/**
 * Endings that promise a result the resume never measured.
 *
 * ", ensuring consistent cloud provisioning and streamlined workflows" says
 * nothing that ", provisioning cloud environments" does not, and it says it in
 * the voice of a brochure. Caught as a shape rather than by word, because the
 * participle that starts it is interchangeable.
 */
export const PURPOSE_CLAUSE =
  /,\s+(ensuring|enabling|allowing|improving|increasing|reducing|driving|delivering|providing|resulting in|leading to|empowering|fostering|facilitating|optimizing|optimising|enhancing|streamlining)\b/i;

export interface VoiceProblem {
  /** The line it was found in. */
  line: string;
  kind: 'banned word' | 'purpose clause' | 'uniform shape';
  detail: string;
}

/** What a resume line may not contain, found rather than assumed. */
export function voiceProblems(lines: readonly string[]): VoiceProblem[] {
  const out: VoiceProblem[] = [];
  const banned = new Set(BANNED_WORDS);

  for (const line of lines) {
    // The SHAPE is tested first, because several of the banned words are also the
    // participles that start a purpose clause — and when a line has both, "this
    // ends with a result clause the resume never measured" tells the writer what
    // to do and "this uses the word ensuring" does not.
    const clause = PURPOSE_CLAUSE.exec(line);
    if (clause) {
      out.push({ line, kind: 'purpose clause', detail: clause[1] ?? '' });
      continue;
    }
    for (const raw of line.toLowerCase().split(/[^a-z-]+/)) {
      if (raw && banned.has(raw)) {
        out.push({ line, kind: 'banned word', detail: raw });
        break;
      }
    }
  }

  const shape = uniformity(lines);
  if (shape) out.push({ line: '', kind: 'uniform shape', detail: shape });
  return out;
}

/**
 * How much bullets under one employer smell of a template.
 *
 * MEASURED, NOT GUESSED
 *
 * Two signals, both computed from the lines themselves:
 *
 *   Length spread. Human bullets vary — a sentence about one thing is shorter
 *   than a sentence about three. A set whose lengths sit within a few characters
 *   of each other was generated to a shape, not written.
 *
 *   Opening repetition. "Built… Built… Built…" or five bullets in a row whose
 *   first word is a past-tense verb from the same small set. Some repetition is
 *   natural; every line is not.
 *
 * Returns a sentence when it is bad enough to say something about, and null when
 * it is not. Deliberately quiet: a false alarm here would have the model rewriting
 * perfectly good lines to satisfy a statistic.
 */
export function uniformity(lines: readonly string[]): string | null {
  const real = lines.map((l) => l.trim()).filter((l) => l.length > 20);
  if (real.length < 4) return null;

  const lengths = real.map((l) => l.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const spread = Math.sqrt(
    lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length,
  );
  // Under a tenth of the mean means every bullet is within a few characters of
  // every other one, across four or more of them. Nobody writes that way.
  if (mean > 0 && spread / mean < 0.1) {
    return `every bullet is about ${Math.round(mean)} characters long — vary them`;
  }

  const openers = real.map((l) => l.split(/\s+/)[0]?.toLowerCase() ?? '');
  const counts = new Map<string, number>();
  for (const o of openers) counts.set(o, (counts.get(o) ?? 0) + 1);
  const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > Math.max(2, real.length * 0.5)) {
    return `${worst[1]} bullets start with "${worst[0]}"`;
  }

  return null;
}

/**
 * The voice half of the prompt.
 *
 * Separate from the factual rules on purpose. Those are absolute and this is
 * craft — and mixing them would let a model trade one off against the other,
 * which is exactly the wrong bargain.
 */
export const VOICE_RULES = [
  'HOW IT MUST READ',
  '',
  'The result has to read as though the candidate wrote it on a good day. Not as',
  'though it was generated. The difference is mostly these:',
  '',
  'V1. NEVER end a bullet with a comma and a participle that claims an unmeasured',
  '    result. Not ", ensuring seamless integration". Not ", improving overall',
  '    efficiency". Not ", driving business value". Stop the sentence when the fact',
  '    stops. This is the single loudest sign a resume was machine-written.',
  'V2. NEVER use these words: leveraged, utilised, spearheaded, orchestrated,',
  '    streamlined, robust, seamless, holistic, comprehensive, extensive,',
  '    cutting-edge, passionate, dynamic, innovative, showcase, facilitate,',
  '    various, numerous. Each has a plainer word that says more.',
  'V3. VARY THE SHAPE. Bullets must differ in length. A point with one fact in it',
  '    is short. Do not pad it to match its neighbours, and do not open every line',
  '    with the same verb.',
  'V4. Lead with the thing that was built or run rather than a verb chosen to sound',
  '    senior — "Built the payment reconciliation service in .NET Core, on AKS" beats',
  '    "Engineered a scalable payment reconciliation microservice". But EVERY BULLET IS',
  '    STILL A SENTENCE WITH A VERB IN IT. "Terraform scripts and ARM templates to',
  '    provision cloud environments" is a fragment and reads as though a word fell out.',
  'V5. KEEP THE CANDIDATE\'S OWN WORDS wherever they already work. A resume that',
  '    comes back entirely reworded reads as somebody else\'s writing, because it',
  '    is. Rewrite the lines that need it and leave the rest alone.',
  'V6. Plain past tense. No first person, no "responsible for", no adjectives',
  '    about the candidate. Say what happened.',
  'V7. Numbers only where the resume already has them. A bullet with no number is',
  '    better than a bullet with an invented one, and far better than one padded',
  '    with words to hide that it has none.',
].join('\n');
