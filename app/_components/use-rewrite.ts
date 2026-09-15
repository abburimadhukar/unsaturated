'use client';

import { useCallback, useState } from 'react';

import type { ChosenBullet, ChosenSkill } from '../../src/tailor/additions.js';
import { applyAdditions, documentFromShape } from '../../src/tailor/additions.js';
import type { CheckedLine, CheckedRewrite } from '../../src/tailor/rewrite.js';
import { assembleRewrite } from '../../src/tailor/rewrite.js';
import type { ResumeShape } from '../../src/tailor/sections.js';
import type { RolesAnswer, SkillsAnswer, SuggestMode } from '../../src/tailor/suggest.js';
import { docxBlob, docxFileName } from '../../src/ui/docx.js';
import { changedLines, readResume } from '../../src/ui/resume-render.js';

/**
 * A whole rewritten resume, and the small amount of judgement only a person has.
 *
 * WHAT CHANGED FROM THE OLD SESSION
 *
 * The old one proposed line edits and made the person accept each. Run for real,
 * it produced seven suggestions of which the most substantial moved "React.js"
 * two words earlier — homework, for no gain.
 *
 * This one hands back a finished document, whole.
 *
 * INCLUSION IS THE DEFAULT AND REMOVAL IS THE CONTROL
 *
 * It used to be the other way round. A line the checker could not verify was held
 * OUT of the document until the person clicked to put it in, and a line it could
 * not verify at all never arrived. Both of those were the code deciding what
 * somebody's CV should say, on evidence — a one-page summary of a career — that
 * was never good enough to support the decision.
 *
 * So everything the model wrote is in the document. Lines the checker could not
 * trace are marked in the sheet, listed with the reason in plain words, and one
 * click takes any of them out. `removed` is that list.
 *
 * This is louder than the old behaviour, not quieter: a flagged line is visible in
 * the document itself and its count travels with the download button, where
 * before it was simply absent and the person had no idea what had been decided
 * for them.
 */

export interface RewriteResponse {
  rewrite?: CheckedRewrite | null;
  shape?: ResumeShape;
  model?: string;
  note?: string;
  needsAttention?: boolean;
  /** Characters of the stored resume the model never saw. Zero in every real case. */
  resumeCutBy?: number;
  via?: string;
  jobDescription?: string;
  jobDescriptionTruncated?: boolean;
  error?: string;
  needsResume?: boolean;
  retryable?: boolean;
  noDescription?: boolean;
}

/** What /api/tailor/suggest returns. No verdicts — see src/tailor/suggest.ts. */
export interface SuggestResponse {
  mode?: SuggestMode;
  skills?: SkillsAnswer | null;
  roles?: RolesAnswer | null;
  shape?: ResumeShape;
  model?: string;
  note?: string;
  needsAttention?: boolean;
  resumeCutBy?: number;
  error?: string;
  needsResume?: boolean;
  retryable?: boolean;
  noDescription?: boolean;
}

export interface RewriteSession {
  ask: string;
  setAsk: (s: string) => void;

  busy: boolean;
  res: RewriteResponse | null;
  run: () => Promise<void>;

  /** Lines the person has taken out, by their exact text. */
  removed: Set<string>;
  remove: (line: string) => void;
  keep: (line: string) => void;
  /** Every line the checker could not confirm, in or out. */
  flagged: CheckedLine[];
  /** Which lines of the assembled document are flagged, so the sheet can mark them. */
  flaggedLines: Set<number>;

  /**
   * One answer per button, kept apart so both can be on screen at once.
   *
   * A single slot meant running the second question threw away the first, and
   * the two are meant to be read together — the skills you are missing, and the
   * responsibilities that would cover them. Ticks from both apply to the same
   * document at the same time.
   */
  sug: Record<SuggestMode, SuggestResponse | null>;
  /** Which button is waiting on the model, if either. */
  asking: SuggestMode | null;
  askFor: (mode: SuggestMode) => Promise<void>;
  /** Suggestions the person ticked, by the exact text of the item. */
  picked: Set<string>;
  pick: (key: string) => void;

  /** Lines put back to the person's own words, by the rewrite's text. */
  reverted: Set<string>;
  revert: (text: string) => void;
  restore: (text: string) => void;

  /** The finished document, as it currently stands. */
  document: string;
  /** The resume as it was, for the side-by-side. */
  original: string;
  /** Hand edits to the finished document, which survive a revert. */
  edited: string | null;
  setEdited: (s: string | null) => void;

  saving: boolean;
  copied: boolean;
  copy: () => void;
  saveDocx: () => Promise<void>;
  printable: () => void;
  error: string;
}

export function useRewrite(jobKey: string, jobTitle: string): RewriteSession {
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RewriteResponse | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  /**
   * The two suggestion buttons, which are their own feature.
   *
   * Kept apart from `res` on purpose: they answer a different question, they do
   * not produce a document, and either can be run without the other or without a
   * rewrite at all. Sharing one response object would have made "have you run the
   * rewrite" a precondition for a button that has nothing to do with it.
   *
   * `picked` holds what the person ticked, by the exact text of the item. Nothing
   * reaches the document until it is in here.
   */
  const [sug, setSug] = useState<Record<SuggestMode, SuggestResponse | null>>({
    skills: null,
    roles: null,
  });
  const [asking, setAsking] = useState<SuggestMode | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());


  const pick = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = useCallback(async () => {
    setBusy(true);
    setRes(null);
    setRemoved(new Set());
    setReverted(new Set());
    setEdited(null);
    setError('');
    try {
      const r = await fetch('/api/tailor/rewrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobKey, ask: ask.trim() || null }),
      });
      // Parsed whatever the status: every error this route returns carries a
      // sentence, and "something went wrong" would throw away the useful part.
      setRes((await r.json().catch(() => ({}))) as RewriteResponse);
    } catch {
      setRes({ error: 'could not reach the server — check your connection and try again' });
    } finally {
      setBusy(false);
    }
  }, [jobKey, ask]);

  /**
   * One question to the model, and nothing done to the answer.
   *
   * Ticks are cleared on every run, because a tick refers to one exact suggestion
   * and the next run produces different ones. Keeping them would leave the
   * document holding a line nothing on screen accounts for.
   */
  const askFor = useCallback(
    async (mode: SuggestMode) => {
      setAsking(mode);
      // Only this mode's answer is cleared. The other button's results stay on
      // screen, because the two are meant to be read and ticked together.
      setSug((prev) => ({ ...prev, [mode]: null }));
      setError('');
      try {
        const r = await fetch('/api/tailor/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobKey, mode }),
        });
        const body = (await r.json().catch(() => ({}))) as SuggestResponse;
        setSug((prev) => ({ ...prev, [mode]: body }));
      } catch {
        setSug((prev) => ({
          ...prev,
          [mode]: { error: 'could not reach the server — check your connection and try again' },
        }));
      } finally {
        setAsking(null);
      }
    },
    [jobKey],
  );

  const rewrite = res?.rewrite ?? null;
  // The rewrite's copy wins when both exist: it is the one the document is built
  // from, and two shapes of the same CV would differ only by being read twice.
  const shape = res?.shape ?? sug.skills?.shape ?? sug.roles?.shape ?? null;

  const suggestedSkills = sug.skills?.skills?.skills ?? [];
  const suggestedCompanies = sug.roles?.roles?.companies ?? [];

  const chosenSkills: ChosenSkill[] = suggestedSkills
    .filter((s) => picked.has(s.skill))
    .map((s) => ({ skill: s.skill, intoLine: s.intoLine, newLine: s.newLine }));

  const chosenBullets: ChosenBullet[] = suggestedCompanies.flatMap((c) =>
    c.bullets
      .filter((b) => picked.has(b.text))
      .map((b) => ({ company: c.company, header: c.header, text: b.text })),
  );

  // Every flagged line, whether or not it is still in the document. One that has
  // been taken out stays on this list so it can be put back — a decision you
  // cannot reverse is not much better than one you were never offered.
  const flagged: CheckedLine[] = rewrite
    ? [rewrite.summary, ...rewrite.skills, ...rewrite.companies.flatMap((c) => c.lines)].filter(
        (l) => l.verdict === 'flagged' && l.text,
      )
    : [];

  const remove = (line: string) =>
    setRemoved((r) => {
      const next = new Set(r);
      next.add(line);
      return next;
    });
  const keep = (line: string) =>
    setRemoved((r) => {
      const next = new Set(r);
      next.delete(line);
      return next;
    });

  const revert = (text: string) =>
    setReverted((r) => {
      const next = new Set(r);
      next.add(text);
      return next;
    });
  const restore = (text: string) =>
    setReverted((r) => {
      const next = new Set(r);
      next.delete(text);
      return next;
    });

  // The document in three layers, each rebuilt from the one below it.
  //
  //   base       the rewrite if one was run, otherwise the person's own CV — so
  //              the two suggestion buttons work without paying for a rewrite
  //   additions  the suggestions they ticked, put in place
  //   edited     whatever they typed, which wins until they clear it
  //
  // Rebuilt rather than accumulated, so un-ticking a suggestion removes it again.
  const original = shape ? documentFromShape(shape) : '';
  const base = rewrite && shape ? assembleRewrite(rewrite, shape, removed, reverted) : original;
  const withAdditions = applyAdditions(base, chosenSkills, chosenBullets);

  // A hand edit wins over the assembled document until it is cleared. Assembling
  // over the top would throw away what somebody typed the moment they reverted an
  // unrelated line, which is the bug the old screen had.
  const document_ = edited ?? withAdditions;

  // Marked in the sheet itself, not only in the list beside it. A flagged line
  // that is in the document by default has to be visible IN the document, or
  // inclusion-by-default becomes its own kind of silence. A line edited by hand
  // stops matching and stops being marked, which is right: it is theirs now.
  const flaggedLines = changedLines(
    document_,
    flagged.filter((l) => !removed.has(l.text)).map((l) => l.text),
  );


  const copy = () => {
    if (!document_) return;
    void navigator.clipboard?.writeText(document_);
    setCopied(true);
  };

  const saveDocx = async () => {
    if (!document_) return;
    setSaving(true);
    try {
      const blob = await docxBlob(document_);
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = docxFileName(jobTitle);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('could not build the .docx — copy the text instead');
    } finally {
      setSaving(false);
    }
  };

  /**
   * PDF through the browser's own print dialogue.
   *
   * Not a hand-rolled PDF: laying out the text layer by hand produces a file that
   * looks right and extracts as "Ranmulti-regionAWS", which is the failure that
   * matters because the first reader of a resume is usually a parser.
   */
  const printable = () => {
    if (!document_) return;
    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) {
      setError('your browser blocked the print window — allow pop-ups, or download the .docx');
      return;
    }
    const esc = (t: string) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = readResume(document_)
      .map((b) => {
        if (b.kind === 'blank') return '<div class="gap"></div>';
        if (b.kind === 'name') return `<h1>${esc(b.text)}</h1>`;
        if (b.kind === 'contact') return `<p class="contact">${esc(b.text)}</p>`;
        if (b.kind === 'heading') return `<h2>${esc(b.text)}</h2>`;
        if (b.kind === 'bullet') {
          return `<p class="bullet"><span class="m">${esc(b.marker ?? '·')}</span><span>${esc(b.text)}</span></p>`;
        }
        return `<p>${esc(b.text)}</p>`;
      })
      .join('');
    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8">' +
        `<title>${docxFileName(jobTitle).replace(/\.docx$/, '')}</title>` +
        '<style>@page{size:A4;margin:18mm}' +
        'body{font:11pt/1.5 Calibri,Carlito,system-ui,sans-serif;color:#000;margin:0}' +
        'h1{font-size:17pt;margin:0 0 2pt}' +
        'h2{font-size:11pt;text-transform:uppercase;letter-spacing:.07em;margin:12pt 0 4pt;' +
        'padding-bottom:2pt;border-bottom:.5pt solid #999}' +
        '.contact{font-size:9.5pt;color:#444;margin:0}' +
        'p{margin:0 0 2pt}.bullet{display:flex;gap:6pt}.m{flex:0 0 auto}.gap{height:7pt}' +
        '</style></head><body>' +
        body +
        '</body></html>',
    );
    w.document.close();
    w.focus();
    w.print();
  };

  return {
    ask,
    setAsk,
    busy,
    res,
    run,
    removed,
    remove,
    keep,
    flagged,
    flaggedLines,
    sug,
    asking,
    askFor,
    picked,
    pick,
    reverted,
    revert,
    restore,
    document: document_,
    original,
    edited,
    setEdited,
    saving,
    copied,
    copy,
    saveDocx,
    printable,
    error: error || res?.error || '',
  };
}
