import type { Answer, Need } from './coverage.js';
import { checkRewrite, type CheckedRewrite, type RewriteAnswer } from './rewrite.js';
import { buildRewriteMessages, type Preset, type RewriteInput } from './rewrite-prompt.js';
import { OPENAI_URL, TAILOR_MODEL, extractJson } from './run.js';

/**
 * One rewrite: ask for the document, check every line of it, report.
 *
 * Same shape as run.ts and for the same reasons — nothing throws, the checked
 * result is the only thing that can leave this module, and a refused key or a
 * spent quota comes back as a sentence rather than a 500.
 */

/** A resume with more employers than this is not a resume. */
const MAX_COMPANIES = 12;
/** Bullets per employer. Beyond this it is a job description, not a CV. */
const MAX_BULLETS = 10;
const MAX_SKILL_LINES = 12;
const MAX_DROPPED = 20;
/** A posting asking for more than this is listing adjectives. */
const MAX_REQUIREMENTS = 24;
const MAX_LINE_CHARS = 400;

const RESPONSE_SCHEMA = {
  name: 'tailored_resume',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'summaryWhy', 'skills', 'companies', 'dropped', 'requirements'],
    properties: {
      summary: { type: 'string', description: 'three sentences at most, aimed at this posting' },
      summaryWhy: { type: 'string', description: 'why it reads this way, one sentence' },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'the skills lines, reordered. Nothing added that the resume lacks.',
      },
      companies: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['company', 'role', 'header', 'bullets'],
          properties: {
            company: { type: 'string', description: 'exactly as named in the resume' },
            role: { type: 'string' },
            header: { type: 'string', description: 'the employer line, unchanged' },
            bullets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'from', 'why'],
                properties: {
                  text: { type: 'string' },
                  from: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "original line(s) from THIS employer that it came from",
                  },
                  why: { type: 'string', description: 'why it matters for this posting' },
                },
              },
            },
          },
        },
      },
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'need', 'answer', 'fromPosting', 'fromResume', 'insteadYouHave', 'advice'],
          properties: {
            name: { type: 'string' },
            need: {
              type: 'string',
              enum: ['must', 'nice', 'eligibility'],
              description:
                'eligibility for work authorisation, location, clearance — not a skill',
            },
            answer: {
              type: 'string',
              enum: ['shown', 'partial', 'adjacent', 'missing', 'unclear'],
            },
            fromPosting: { type: 'string', description: 'short quote from the posting' },
            fromResume: {
              type: 'string',
              description: 'quote copied EXACTLY from the resume; empty unless shown or partial',
            },
            insteadYouHave: {
              type: 'string',
              description:
                'for answer=adjacent ONLY: the equivalent the candidate does have, named, and it must be in the resume',
            },
            advice: { type: 'string', description: 'one sentence on what to do' },
          },
        },
      },
      dropped: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'why'],
          properties: { text: { type: 'string' }, why: { type: 'string' } },
        },
      },
    },
  },
} as const;

export interface RewriteResult {
  checked: CheckedRewrite | null;
  used: Preset[];
  model: string;
  note: string;
  needsAttention: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const trim = (v: unknown, max = MAX_LINE_CHARS): string =>
  str(v).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The model's answer, reduced to the shape this module promises.
 *
 * Tolerant in one direction only: a malformed bullet becomes a bullet with empty
 * fields, which checkBullet then drops. Nothing here decides a line is acceptable.
 */
export function parseRewrite(body: unknown): RewriteAnswer {
  const root = (body ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  return {
    summary: trim(root.summary, 800),
    summaryWhy: trim(root.summaryWhy),
    skills: arr(root.skills).slice(0, MAX_SKILL_LINES).map((s) => trim(s)).filter(Boolean),
    companies: arr(root.companies)
      .slice(0, MAX_COMPANIES)
      .map((c) => {
        const row = (c ?? {}) as Record<string, unknown>;
        return {
          company: trim(row.company, 120),
          role: trim(row.role, 120),
          header: trim(row.header, 200),
          bullets: arr(row.bullets)
            .slice(0, MAX_BULLETS)
            .map((b) => {
              const bb = (b ?? {}) as Record<string, unknown>;
              return {
                text: trim(bb.text),
                from: arr(bb.from).map((f) => trim(f)).filter(Boolean),
                why: trim(bb.why),
              };
            })
            .filter((b) => b.text.length > 0),
        };
      })
      .filter((c) => c.company.length > 0),
    // Anything unreadable becomes `unclear` and `must`, which is the safe
    // direction: "they want this and we could not confirm you have it" is true of
    // a value we cannot read, and treating an unknown need as a must-have errs
    // towards showing the person something rather than hiding it.
    requirements: arr(root.requirements)
      .slice(0, MAX_REQUIREMENTS)
      .map((r) => {
        const row = (r ?? {}) as Record<string, unknown>;
        const need = trim(row.need, 20).toLowerCase();
        const answer = trim(row.answer, 20).toLowerCase();
        return {
          name: trim(row.name, 160),
          need: (['must', 'nice', 'eligibility'].includes(need) ? need : 'must') as Need,
          answer: (['shown', 'partial', 'adjacent', 'missing', 'unclear'].includes(answer)
            ? answer
            : 'unclear') as Answer,
          fromPosting: trim(row.fromPosting),
          fromResume: trim(row.fromResume),
          insteadYouHave: trim(row.insteadYouHave, 200),
          advice: trim(row.advice),
        };
      })
      .filter((r) => r.name.length > 0),
    dropped: arr(root.dropped)
      .slice(0, MAX_DROPPED)
      .map((d) => {
        const row = (d ?? {}) as Record<string, unknown>;
        return { text: trim(row.text), why: trim(row.why) };
      })
      .filter((d) => d.text.length > 0),
  };
}

export interface RewriteOptions {
  apiKey?: string | undefined;
  model?: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
}

const idle = (model: string, note: string, needsAttention = false): RewriteResult => ({
  checked: null,
  used: [],
  model,
  note,
  needsAttention,
});

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

export async function rewriteResume(
  input: RewriteInput,
  opts: RewriteOptions = {},
): Promise<RewriteResult> {
  const model = opts.model ?? TAILOR_MODEL;

  // `||` over `??`: a missing GitHub secret arrives as '' and not as undefined,
  // so a `??` chain reports a missing key as present.
  const apiKey = [opts.apiKey, process.env.OPENAI_API_KEY].find(
    (v) => typeof v === 'string' && v.trim() !== '',
  );
  if (!apiKey) return idle(model, 'tailoring is not configured — OPENAI_API_KEY is not set', true);
  if (!input.resumeText.trim()) return idle(model, 'add your resume first');
  if (!input.jobDescription.trim()) return idle(model, 'this posting has no description');

  const { system, user, used } = buildRewriteMessages(input);
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
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
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

    const checked = checkRewrite(parseRewrite(extractJson(content)), input.resumeText);
    return {
      checked,
      used,
      model,
      note:
        `${checked.kept} lines verified, ${checked.asked} need a yes from you, ` +
        `${checked.discarded} discarded`,
      needsAttention: false,
    };
  }

  return idle(model, `OpenAI was unreachable after ${attempts} attempts: ${lastError}`);
}
