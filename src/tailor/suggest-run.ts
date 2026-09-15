import { OPENAI_URL, TAILOR_MODEL, extractJson } from './run.js';
import {
  ROLES_SCHEMA,
  SKILLS_SCHEMA,
  parseRoles,
  parseSkills,
  suggestSystem,
  suggestUser,
  type RolesAnswer,
  type SkillsAnswer,
  type SuggestInput,
  type SuggestMode,
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
          response_format: {
            type: 'json_schema',
            json_schema: mode === 'skills' ? SKILLS_SCHEMA : ROLES_SCHEMA,
          },
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
    if (mode === 'skills') {
      const skills = parseSkills(json);
      return {
        skills,
        roles: null,
        model,
        note: `${skills.skills.length} skill${skills.skills.length === 1 ? '' : 's'} the posting asks for that your resume does not show`,
        needsAttention: false,
      };
    }

    const roles = parseRoles(json);
    const total = roles.companies.reduce((n, c) => n + c.bullets.length, 0);
    return {
      skills: null,
      roles,
      model,
      note: `${total} suggested point${total === 1 ? '' : 's'} across ${roles.companies.length} employer${roles.companies.length === 1 ? '' : 's'}`,
      needsAttention: false,
    };
  }

  return idle(model, `OpenAI was unreachable after ${attempts} attempts: ${lastError}`);
}
