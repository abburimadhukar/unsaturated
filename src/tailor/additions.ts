import { normalise } from './edits.js';
import { isCompanyHeader, isSectionHeading, readShape } from './sections.js';

/**
 * Putting a ticked suggestion into the document. The only job code has here.
 *
 * Everything upstream of this file is the model's opinion and the person's
 * decision. This is the mechanical part: they said yes to a skill or a
 * responsibility, and it has to end up in the right place in the text — the skill
 * on the right skills line, the bullet under the right employer, both reading as
 * though they had been typed there.
 *
 * NOTHING HERE JUDGES ANYTHING
 *
 * It does not check the suggestion against the resume, it does not downgrade it,
 * it does not refuse it. If a line cannot be found it appends rather than
 * dropping, because a suggestion the person ticked and then could not find would
 * be the worst outcome of the lot.
 */

/** A skills line the person accepted, with the new version of that line. */
export interface ChosenSkill {
  skill: string;
  /** The existing line to replace, copied from the resume. Empty for a new line. */
  intoLine: string;
  /** What the line reads as with the skill in it. */
  newLine: string;
}

/** A responsibility the person accepted, and the employer it belongs under. */
export interface ChosenBullet {
  company: string;
  header: string;
  text: string;
}

/** The marker the document already uses for its bullets. */
const DEFAULT_MARKER = '· ';
const BULLET_MARKER = /^\s*([•·‣▪●\-*])\s+/;

const same = (a: string, b: string): boolean => normalise(a) === normalise(b);

/** The category a skills line declares: "Monitoring: Splunk" -> "Monitoring". */
export function labelOf(line: string): string {
  const at = line.indexOf(':');
  return at > 0 ? line.slice(0, at).trim() : line.trim();
}

/**
 * One skill appended to a line, unless it is already there.
 *
 * THE LINE IS BUILT HERE, NOT BY THE MODEL, AND THAT IS THE WHOLE POINT
 *
 * This used to take the model's `newLine` — its rewritten version of the whole
 * line — and put it in place of the original. On a real run the model returned
 * `intoLine` correctly and left `newLine` EMPTY, so the fallback kicked in and
 * replaced the line with the bare skill name. The result:
 *
 *   before   Cloud Technologies: Azure DevOps, Azure Kubernetes Services, Azure
 *            PaaS, Azure IaaS, Terraform, Ansible, Docker
 *   after    AWS, Terragrunt, OpenTofu
 *
 * Seven skills the person actually has, deleted, to add three they do not. Two
 * lines went that way in one run.
 *
 * So the model now only says WHICH line. The text of it is assembled from the
 * line that is really in the document plus the skill name, which cannot lose
 * anything that was there. The cost is that a skill lands at the end of its list
 * rather than beside its relatives; that is a rounding error next to deleting
 * somebody's skills section.
 */
export function addSkillTo(current: string, skill: string): string {
  const name = skill.trim();
  if (!name || normalise(current).includes(normalise(name))) return current;
  return current.trim() ? `${current.trim()}, ${name}` : name;
}

/**
 * The line a group of chosen skills produces.
 *
 * The base is the EXISTING line when there is one — never the model's rewrite of
 * it. A brand-new line has nothing to lose, so there the model's wording is used
 * as given.
 *
 * Exported because the screen previews this before anything is ticked, and two
 * implementations of it would eventually disagree about what lands.
 */
export function mergeSkillLine(chosen: readonly ChosenSkill[], existing?: string): string {
  let out: string | null = null;
  for (const s of chosen) {
    if (out === null) {
      out = (existing ?? s.intoLine).trim() || s.newLine.trim() || s.skill.trim();
    }
    out = addSkillTo(out, s.skill);
  }
  return out ?? '';
}

/** Where a company's own lines end: the next employer, the next section, or the end. */
function endOfCompanyBlock(lines: readonly string[], headerAt: number): number {
  let i = headerAt + 1;
  let last = headerAt;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const t = line.trim();
    if (!t) continue;
    if (isCompanyHeader(t) || isSectionHeading(t)) break;
    last = i;
  }
  return last;
}

/** The bullet marker in use near a point in the document, so an insert matches it. */
function markerNear(lines: readonly string[], from: number, to: number): string {
  for (let i = to; i > from; i--) {
    const m = BULLET_MARKER.exec(lines[i] ?? '');
    if (m) return `${m[1]} `;
  }
  return DEFAULT_MARKER;
}

/**
 * The document with every ticked suggestion in it.
 *
 * Rebuilt from the base text each time rather than accumulated, so un-ticking an
 * item removes it again and ticking two things twice cannot duplicate either.
 */
export function applyAdditions(
  document: string,
  skills: readonly ChosenSkill[],
  bullets: readonly ChosenBullet[],
): string {
  if (skills.length === 0 && bullets.length === 0) return document;

  let lines = document.replace(/\r\n?/g, '\n').split('\n');

  // ---- skills -----------------------------------------------------------
  //
  // The model is asked to copy the line exactly, so the common case is a direct
  // replacement. Anything it could not place goes into the skills section as its
  // own line rather than being quietly dropped.
  // Accumulated per line, not applied one at a time.
  //
  // Two skills for the same category is the normal case — a posting wanting
  // Datadog and Prometheus produces two suggestions both aimed at "Monitoring:
  // Splunk, AppInsights". Replacing the line as each one is applied meant the
  // second could no longer find the line it was written against, so it became a
  // second line, and the CV ended up with two contradictory Monitoring rows.
  //
  // So the first suggestion for a line takes the model's rewritten version, and
  // every later one appends just its own skill to whatever the line has become.
  const byLine = new Map<number, string>();
  // New lines are grouped by their label too. Three skills the model could not
  // place used to become three one-item categories — "Operating Systems: Linux",
  // "AI-Assisted Engineering: AI coding assistants" — which is what a padded CV
  // looks like. Same label, same line.
  const byLabel = new Map<string, string>();

  for (const s of skills) {
    if (!s.skill.trim() && !s.newLine.trim()) continue;
    const at = s.intoLine.trim() ? lines.findIndex((l) => l.trim() && same(l, s.intoLine)) : -1;

    if (at >= 0) {
      // Built from the line that is really in the document, so nothing on it can
      // be lost however the model filled in `newLine`.
      byLine.set(at, addSkillTo(byLine.get(at) ?? (lines[at] ?? '').trim(), s.skill));
      continue;
    }

    const text = s.newLine.trim() || s.skill.trim();
    const key = normalise(labelOf(text));
    const base = byLabel.get(key);
    byLabel.set(key, base === undefined ? text : addSkillTo(base, s.skill));
  }
  for (const [at, text] of byLine) lines[at] = text;
  const unplaced = [...byLabel.values()];

  if (unplaced.length > 0) {
    const shape = readShape(lines.join('\n'));
    const lastSkillLine = shape.skills.length
      ? lines.reduce((best, l, i) => (shape.skills.some((s) => same(s, l)) ? i : best), -1)
      : -1;
    if (lastSkillLine >= 0) {
      lines.splice(lastSkillLine + 1, 0, ...unplaced);
    } else {
      // No skills section at all. One is made, above the experience if there is
      // any, so the document still reads in the order a resume reads.
      const before = lines.findIndex((l) => /experience|employment|work history/i.test(l.trim()) && isSectionHeading(l.trim()));
      const block = ['TECHNICAL SKILLS', ...unplaced, ''];
      if (before >= 0) lines.splice(before, 0, ...block);
      else lines.push('', ...block);
    }
  }

  // ---- responsibilities -------------------------------------------------
  //
  // Inserted after the employer's last existing line, so a new point joins the
  // bottom of that job rather than displacing what is already there. Applied
  // back to front: an insert shifts every line below it, and going forwards
  // would make each later header index wrong.
  const placed = bullets
    .map((b) => {
      const at = lines.findIndex(
        (l) => l.trim() && (same(l, b.header) || (b.company && same(l, b.company))),
      );
      return { bullet: b, at };
    })
    .filter((p) => p.at >= 0)
    .sort((a, b) => b.at - a.at);

  for (const { bullet, at } of placed) {
    const end = endOfCompanyBlock(lines, at);
    const marker = markerNear(lines, at, end);
    lines.splice(end + 1, 0, `${marker}${bullet.text.trim()}`);
  }

  // Anything whose employer is not in the document is appended under its own
  // header rather than lost. It should not happen — the headers come from the
  // same resume — but silently dropping a line somebody ticked would be the one
  // unrecoverable outcome.
  const missing = bullets.filter(
    (b) => !lines.some((l) => l.trim() && (same(l, b.header) || (b.company && same(l, b.company)))),
  );
  if (missing.length > 0) {
    for (const b of missing) {
      lines.push('', b.header.trim() || b.company.trim(), `${DEFAULT_MARKER}${b.text.trim()}`);
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A resume rebuilt from its parsed shape.
 *
 * Shared, because the suggestion buttons work on a person's own CV whether or not
 * they have run the rewrite — and without this they would have nothing to add to
 * until they had spent money on a rewrite they may not want.
 */
export function documentFromShape(shape: {
  name: string;
  contact: string[];
  summary: string[];
  skills: string[];
  companies: { header: string; role: string; bullets: string[] }[];
  education: string[];
}): string {
  const out: string[] = [];
  if (shape.name) out.push(shape.name);
  out.push(...shape.contact, '');
  if (shape.summary.length) out.push(...shape.summary, '');
  if (shape.skills.length) out.push('TECHNICAL SKILLS', ...shape.skills, '');
  if (shape.companies.length) {
    out.push('PROFESSIONAL EXPERIENCE');
    for (const c of shape.companies) {
      out.push(c.header);
      if (c.role) out.push(c.role);
      for (const b of c.bullets) out.push(`${DEFAULT_MARKER}${b}`);
      out.push('');
    }
  }
  if (shape.education.length) out.push('EDUCATION', ...shape.education);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
