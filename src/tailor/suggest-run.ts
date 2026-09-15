import { OPENAI_URL, TAILOR_MODEL, extractJson } from './run.js';
import {
  FULL_SCHEMA,
  ROLES_SCHEMA,
  SKILLS_SCHEMA,
  SUMMARY_SCHEMA,
  parseFull,
  parseRoles,
  parseSkills,
  parseSummary,
  suggestSystem,
  suggestUser,
  type FullAnswer,
  type RolesAnswer,
  type SkillsAnswer,
  type SuggestInput,
  type SuggestMode,
  type SummaryAnswer,
} from './suggest.js';

/**
 * One suggestion call. Same plumbing as its siblings, and deliberately no checker.
 *
 * `rewriteResume` hands its answer to `checkRewrite` before anything leaves the
 * module. This one does not, and the absence is the point — see the note at the
 * top of suggest.ts. What comes back is the model's answer, parsed into a known
 * shape and passed on.
 *
 * Nothing throws. A refused key or a spent quota comes back as a sentence.
 */

export interface SuggestResult {
  skills: SkillsAnswer | null;
  roles: RolesAnswer | null;
  summary: SummaryAnswer | null;
  full: FullAnswer | null;
  model: string;
  note: string;
  needsAttention: boolean;
}

export interface SuggestOptions {
  apiKey?: string | undefined;
  model?: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
}

const idle = (model: string, note: string, needsAttention = false): SuggestResult => ({
  skills: null,
  roles: null,
  summary: null,
  full: null,
  model,
  note,
  needsAttention,
});

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

export async function suggest(
  input: SuggestInput,
  mode: SuggestMode,
  opts: SuggestOptions = {},
): Promise<SuggestResult> {
  const model = opts.model ?? TAILOR_MODEL;

  // `find` over `??`: a missing GitHub secret arrives as '' and not as undefined,
  // so a `??` chain reports a missing key as present.
  const apiKey = [opts.apiKey, process.env.OPENAI_API_KEY].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  if (!apiKey) return idle(model, 'tailoring is not configured — OPENAI_API_KEY is not set', true);
  if (!input.resumeText.trim()) return idle(model, 'add your resume first');
  if (!input.jobDescription.trim()) return idle(model, 'this posting has no description');

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
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: suggestSystem(mode) },
            { role: 'user', content: suggestUser(input, mode) },
          ],
          response_format: { type: 'json_schema', json_schema: schemaFor(mode) },
        }),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'network error';
      if (attempt < attempts - 1) await wait(500 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = `${res.status} ${body.slice(0, 200)}`;
      if (res.status === 401 || res.status === 403) {
        return idle(model, 'OpenAI refused the key — it is wrong, revoked or out of credit', true);
      }
      if (res.status === 400) {
        return idle(model, `OpenAI rejected the request for "${model}": ${body.slice(0, 200)}`, true);
      }
      if (!isTransient(res.status)) return idle(model, `OpenAI failed: ${lastError}`, true);
      if (attempt < attempts - 1) await wait(500 * (attempt + 1));
      continue;
    }

    const payload = (await res.json().catch(() => null)) as
      | { choices?: { message?: { content?: string | null } }[] }
      | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return idle(model, 'OpenAI returned an empty answer');

    const json = extractJson(content);
    const empty = { skills: null, roles: null, summary: null, full: null, model, needsAttention: false };

    if (mode === 'skills') {
      const skills = parseSkills(json);
      const n = skills.skills.length;
      return { ...empty, skills, note: `${n} skill${n === 1 ? '' : 's'} the posting asks for that your resume does not show` };
    }

    if (mode === 'roles') {
      const roles = parseRoles(json);
      const total = roles.companies.reduce((n, c) => n + c.bullets.length, 0);
      return {
        ...empty,
        roles,
        note: `${total} suggested point${total === 1 ? '' : 's'} across ${roles.companies.length} employer${roles.companies.length === 1 ? '' : 's'}`,
      };
    }

    if (mode === 'summary') {
      const summary = parseSummary(json);
      const n = summary.options.length;
      return {
        ...empty,
        summary,
        // Zero is a real answer here and the prompt asks for it explicitly: a
        // summary already aimed at this posting does not need three versions of
        // itself offered back.
        note: n === 0
          ? 'your summary already reads for this posting — nothing worth changing'
          : `${n} lightly edited version${n === 1 ? '' : 's'} to choose between`,
      };
    }

    const full = parseFull(json);
    const bullets = full.companies.reduce((n, c) => n + c.bullets.length, 0);
    return {
      ...empty,
      full,
      note: `${full.companies.length} employer${full.companies.length === 1 ? '' : 's'}, ${bullets} lines`,
    };
  }

  return idle(model, `OpenAI was unreachable after ${attempts} attempts: ${lastError}`);
}

/** Which JSON shape the model is held to, per question. */
function schemaFor(mode: SuggestMode) {
  if (mode === 'skills') return SKILLS_SCHEMA;
  if (mode === 'roles') return ROLES_SCHEMA;
  if (mode === 'summary') return SUMMARY_SCHEMA;
  return FULL_SCHEMA;
}
