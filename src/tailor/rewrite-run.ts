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

/**
 * Ceilings, set well above anything a real resume or posting reaches.
 *
 * These are here to stop a runaway answer from filling a page with ten thousand
 * bullets, and for nothing else. They used to be tight enough to bite — twelve
 * employers, ten bullets each — which made them a silent editor: the eleventh
 * bullet under a long job simply never existed, and nobody was told.
 *
 * So they are now loose enough that real content never meets them, and if one
 * ever does fire it is recorded in `dropped` and shown on screen with the rest.
 */
const MAX_COMPANIES = 40;
const MAX_BULLETS = 40;
const MAX_SKILL_LINES = 40;
const MAX_DROPPED = 80;
const MAX_REQUIREMENTS = 80;
/** Roughly six lines of prose. A CV bullet is a fifth of this. */
const MAX_LINE_CHARS = 2_000;

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
 * NOTHING IS QUIETLY LOST HERE
 *
 * The only things this function removes are values with no content at all — a
 * bullet whose text is the empty string, a requirement with no name. Everything
 * else survives, including answers the checker will go on to disagree with,
 * because deciding what is worth showing is not this layer's job and is not the
 * checker's job either.
 *
 * Where a ceiling does fire, the overflow is written into `dropped`, which is the
 * channel the screen already renders under "lines left out of this version". A
 * cap somebody can read about is a cap; a cap nobody is told about is data loss.
 */
export function parseRewrite(body: unknown): RewriteAnswer {
  const root = (body ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const over: { text: string; why: string }[] = [];
  const cap = <T,>(items: T[], max: number, what: string): T[] => {
    if (items.length <= max) return items;
    over.push({
      text: `${items.length - max} more ${what}`,
      why: `over the ${max} ${what} this page will render — nothing real reaches this`,
    });
    return items.slice(0, max);
  };

  const rawCompanies = cap(arr(root.companies), MAX_COMPANIES, 'employers');

  return {
    summary: trim(root.summary, 800),
    summaryWhy: trim(root.summaryWhy),
    skills: cap(arr(root.skills), MAX_SKILL_LINES, 'skills lines')
      .map((s) => trim(s))
      .filter(Boolean),
    companies: rawCompanies
      .map((c, i) => {
        const row = (c ?? {}) as Record<string, unknown>;
        const name = trim(row.company, 120);
        const header = trim(row.header, 200);
        return {
          // An employer the model failed to name still has bullets under it, and
          // throwing those away to tidy up a missing field is exactly the kind of
          // silent edit this file no longer makes. The header is the better name
          // anyway; the index is the last resort.
          company: name || header || `employer ${i + 1}`,
          role: trim(row.role, 120),
          header,
          bullets: cap(arr(row.bullets), MAX_BULLETS, `bullets under ${name || 'one employer'}`)
            .map((b) => {
              const bb = (b ?? {}) as Record<string, unknown>;
              return {
                text: trim(bb.text),
                from: arr(bb.from).map((f) => trim(f)).filter(Boolean),
                why: trim(bb.why),
              };
            })
            .filter((b) => b.text.length > 0),
          named: Boolean(name || header),
        };
      })
      // The one thing still removed here, and it removes nothing: an entry with
      // no name, no header and no bullets is an empty object from a malformed
      // answer. Keeping it would put a heading reading "employer 1" above nothing.
      .filter((c) => c.named || c.bullets.length > 0)
      .map(({ named: _named, ...c }) => c),
    // Anything unreadable becomes `unclear` and `must`, which is the safe
    // direction: "they want this and we could not confirm you have it" is true of
    // a value we cannot read, and treating an unknown need as a must-have errs
    // towards showing the person something rather than hiding it.
    requirements: cap(arr(root.requirements), MAX_REQUIREMENTS, 'requirements')
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
    // The model's own list of what it chose to leave out, plus anything a ceiling
    // above truncated. `over` goes last so a real reason is read first.
    dropped: [
      ...cap(arr(root.dropped), MAX_DROPPED, 'left-out lines')
        .map((d) => {
          const row = (d ?? {}) as Record<string, unknown>;
          return { text: trim(row.text), why: trim(row.why) };
        })
        .filter((d) => d.text.length > 0),
      ...over,
    ],
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
        `${checked.kept} lines verified, ${checked.flagged} for you to check` +
        (checked.flagged === 0 ? '' : ' — nothing was removed'),
      needsAttention: false,
    };
  }

  return idle(model, `OpenAI was unreachable after ${attempts} attempts: ${lastError}`);
}
