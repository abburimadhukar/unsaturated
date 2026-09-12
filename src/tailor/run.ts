import { verifyEdits, type CheckSummary, type CheckedEdit, type Edit } from './edits.js';
import { buildMessages, type Chip } from './prompts.js';

/**
 * Asking the model, and checking the answer before anyone sees it.
 *
 * WHY VERIFICATION LIVES IN HERE AND NOT IN THE ROUTE
 *
 * tailor() returns CheckedEdit, never Edit. There is deliberately no exported
 * path that hands a caller what the model actually said: the only way to get
 * edits out of this module is through verifyEdits, which means a future route, a
 * future background job or a careless refactor cannot accidentally skip the
 * check. Making the unsafe thing unavailable is stronger than documenting that it
 * must not be used.
 *
 * CHAT COMPLETIONS, NOT THE RESPONSES API
 *
 * OpenAI now recommends the Responses API for new work, and Chat Completions
 * continues to work with nothing but a model-name change. Chat Completions is
 * used here because its structured-output contract is the one this code can rely
 * on today; the Responses API's equivalent was not something I could confirm
 * against documentation, and guessing a request shape is how you ship a feature
 * that 400s on first contact. Worth revisiting deliberately, not by assumption.
 *
 * AND WHY THE PARSING IS DEFENSIVE ANYWAY
 *
 * The request asks for JSON and names a schema. That is a request, not a
 * guarantee — and the failure it protects against is not hypothetical: a model
 * that wraps its JSON in a ``` fence, or prefaces it with "Here are the edits:",
 * produces a body that JSON.parse rejects outright. Throwing away a perfectly
 * good answer over a code fence would be a silly way to lose the feature, so the
 * parser looks for the object rather than demanding the body be nothing else.
 *
 * NOTHING HERE THROWS
 *
 * Same rule as the crawl's embedding step, for the same reason: this sits behind
 * a web request that a person is waiting on. A refused key, a spent quota and a
 * model having a moment are all reported as a result with a note, because a 500
 * tells the person nothing they can act on.
 */

/**
 * The default model.
 *
 * gpt-5.6-terra: the middle tier of the current generation, $2 per million input
 * tokens and $12 per million output. A tailor pass is roughly 5,000 in and 800
 * out, so about 2p a time and under £2 a month across five people doing twenty
 * each.
 *
 * A config value rather than a constant in the call, because which model writes
 * most like a person is an empirical question and the plan is to answer it by
 * running the same job through several and comparing the diffs on a real resume.
 * The tiers are gpt-5.6-luna (cheapest), -terra, and -sol (deepest reasoning).
 */
export const TAILOR_MODEL = 'gpt-5.6-terra';

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** Most edits one pass may propose. Beyond this a "tailoring" is a rewrite. */
export const MAX_EDITS = 12;
/** Most gaps reported. A list longer than this is not read by anyone. */
export const MAX_GAPS = 8;
/** Longest single gap note kept, in characters. */
export const MAX_GAP_CHARS = 300;

export interface TailorInput {
  resumeText: string;
  jobTitle: string;
  jobDescription: string;
  /** Chip ids the person turned on. */
  chips: readonly string[];
  custom?: string | null;
}

export interface TailorOptions {
  apiKey?: string | undefined;
  model?: string;
  /** Injected for tests; never set in production. */
  fetchImpl?: typeof fetch;
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
}

export interface TailorResult {
  /** Checked, always. There is no way to get the raw edits out of this module. */
  edits: CheckedEdit[];
  /** What the posting wants that the resume does not show. Observations, not claims. */
  gaps: string[];
  accepted: number;
  flagged: number;
  rejected: number;
  /** Which chips were understood, so the UI can show what was actually applied. */
  used: Chip[];
  model: string;
  /** One line, always present, safe to show a person. */
  note: string;
  /** True when somebody has to change something — a bad key, no quota. */
  needsAttention: boolean;
}

export class TailorError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** True when retrying will never help. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'TailorError';
  }
}

/** Worth trying again, as opposed to worth fixing. */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * The shape asked of the model.
 *
 * `strict` and `additionalProperties: false` together are what make the answer
 * parseable without guesswork. `reason` is required because an edit a person
 * cannot evaluate is an edit they will either accept blindly or skip blindly, and
 * both are worse than not offering it.
 */
const RESPONSE_SCHEMA = {
  name: 'resume_edits',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['edits', 'gaps'],
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['original', 'replacement', 'reason', 'section'],
          properties: {
            original: { type: 'string', description: 'copied exactly from the resume' },
            replacement: { type: 'string' },
            reason: { type: 'string', description: 'why, in one short sentence' },
            section: { type: 'string', description: 'experience, skills, summary, or empty' },
          },
        },
      },
      gaps: {
        type: 'array',
        items: { type: 'string' },
        description: 'what the posting needs that the resume does not evidence',
      },
    },
  },
} as const;

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string; type?: string };
}

/**
 * The JSON object in a response that may not be only JSON.
 *
 * Tries the whole body first, because that is what a well-behaved structured
 * response is. Falls back to the outermost braces, which recovers a fenced or
 * prefaced answer. Returns null rather than throwing: a body that is not JSON at
 * all is a reportable outcome, not an exception.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through.
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A string, or empty. Used so one malformed field cannot discard a whole edit. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The model's answer, reduced to the two lists this module promises.
 *
 * Tolerant on purpose, and tolerant in one direction only: a malformed edit
 * becomes an edit with empty fields, which verifyEdit then rejects. Nothing here
 * decides an edit is acceptable — that is edits.ts's job, and keeping the two
 * apart is what stops a parsing convenience becoming a hole in the check.
 */
export function parseAnswer(body: unknown): { edits: Edit[]; gaps: string[] } {
  const root = (body ?? {}) as { edits?: unknown; gaps?: unknown };

  const rawEdits = Array.isArray(root.edits) ? root.edits : [];
  const edits: Edit[] = rawEdits.slice(0, MAX_EDITS).map((e) => {
    const row = (e ?? {}) as Record<string, unknown>;
    const section = str(row.section).trim();
    return {
      original: str(row.original),
      replacement: str(row.replacement),
      reason: str(row.reason),
      ...(section ? { section } : {}),
    };
  });

  const rawGaps = Array.isArray(root.gaps) ? root.gaps : [];
  const gaps = rawGaps
    .map((g) => str(g).replace(/\s+/g, ' ').trim().slice(0, MAX_GAP_CHARS))
    .filter((g) => g.length > 0)
    .slice(0, MAX_GAPS);

  return { edits, gaps };
}

function idle(model: string, note: string, needsAttention = false): TailorResult {
  return {
    edits: [], gaps: [], accepted: 0, flagged: 0, rejected: 0, used: [],
    model, note, needsAttention,
  };
}

/**
 * One tailoring pass: ask, parse, check, report.
 *
 * Returns in every case. The resume and the posting are the caller's problem to
 * supply; an empty resume is refused here rather than sent, because there would
 * be nothing to verify against and every edit would be rejected after paying for
 * the call.
 */
export async function tailor(input: TailorInput, opts: TailorOptions = {}): Promise<TailorResult> {
  const model = opts.model ?? TAILOR_MODEL;

  // `||` over `??` deliberately, and for a reason this project has already been
  // bitten by: a missing GitHub secret arrives as the empty string, not as
  // undefined, so a `??` chain stops at '' and reports a missing key as present.
  const apiKey = [opts.apiKey, process.env.OPENAI_API_KEY].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  if (!apiKey) {
    return idle(model, 'tailoring is not configured — OPENAI_API_KEY is not set', true);
  }

  if (!input.resumeText.trim()) {
    return idle(model, 'add your resume first — there is nothing to tailor');
  }
  if (!input.jobDescription.trim()) {
    return idle(model, 'this posting has no description to tailor against');
  }

  const { system, user, used } = buildMessages({
    resumeText: input.resumeText,
    jobTitle: input.jobTitle,
    jobDescription: input.jobDescription,
    chips: input.chips,
    custom: input.custom ?? null,
  });

  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await doFetch(OPENAI_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        // No token cap is sent. The parameter was renamed across model
        // generations and an unsupported one is a 400, which would fail the
        // whole feature to enforce a limit the schema and MAX_EDITS already
        // impose. Omitting it is the safe side of an unverified detail.
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        }),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < attempts - 1) await wait(500 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = `HTTP ${res.status} ${body.slice(0, 200)}`;

      if (res.status === 401 || res.status === 403) {
        return idle(model, 'OpenAI refused the API key — it needs replacing', true);
      }
      if (res.status === 429) {
        // Could be the rate limit or a spent balance, and the two need different
        // things from a person, so the message does not pretend to know which.
        return idle(
          model,
          'OpenAI is rate limiting or the account is out of credit — try again shortly',
          false,
        );
      }
      if (res.status === 400) {
        // Most likely the model name or a parameter this generation rejects.
        // Named explicitly because "400" on its own sends someone reading logs.
        return idle(model, `OpenAI rejected the request for "${model}": ${body.slice(0, 200)}`, true);
      }
      if (!isTransient(res.status)) return idle(model, `OpenAI failed: ${lastError}`, true);
      if (attempt < attempts - 1) await wait(500 * (attempt + 1));
      continue;
    }

    const payload = (await res.json().catch(() => null)) as ChatResponse | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      return idle(model, 'OpenAI returned an empty answer');
    }

    const parsed = parseAnswer(extractJson(content));
    const summary: CheckSummary = verifyEdits(parsed.edits, input.resumeText);

    return {
      edits: summary.checked,
      gaps: parsed.gaps,
      accepted: summary.accepted,
      flagged: summary.flagged,
      rejected: summary.rejected,
      used,
      model,
      note: summary.note,
      needsAttention: false,
    };
  }

  return idle(model, `OpenAI was unreachable after ${attempts} attempts: ${lastError}`);
}
