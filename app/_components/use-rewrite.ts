'use client';

import { useCallback, useState } from 'react';

import type { CheckedLine, CheckedRewrite } from '../../src/tailor/rewrite.js';
import { assembleRewrite } from '../../src/tailor/rewrite.js';
import type { ResumeShape } from '../../src/tailor/sections.js';
import { docxBlob, docxFileName } from '../../src/ui/docx.js';
import { readResume } from '../../src/ui/resume-render.js';

/**
 * A whole rewritten resume, and the one thing the person has to do.
 *
 * WHAT CHANGED FROM THE OLD SESSION
 *
 * The old one proposed line edits and made the person accept each. Run for real,
 * it produced seven suggestions of which the most substantial moved "React.js"
 * two words earlier — homework, for no gain.
 *
 * This one hands back a finished document. Nothing needs accepting, because every
 * line in it has already been traced to the candidate's own words for the
 * employer it sits under.
 *
 * EXCEPT THE QUESTIONS, WHICH ARE THE POINT
 *
 * A line the model wrote that the resume supports SOMEWHERE but not at that
 * employer becomes a question: "Did you use Kubernetes at Infosys?" It is out of
 * the document until the person says yes. That is the only interaction, it is
 * short, and it is the one thing software genuinely cannot decide for them.
 *
 * NOTHING IS ASSEMBLED FROM AN UNANSWERED QUESTION. An unanswered question is not
 * a yes, and a download containing something nobody stood behind is the worst
 * thing this feature could produce.
 */

export interface RewriteResponse {
  rewrite?: CheckedRewrite | null;
  shape?: ResumeShape;
  used?: string[];
  model?: string;
  note?: string;
  needsAttention?: boolean;
  via?: string;
  jobDescription?: string;
  jobDescriptionTruncated?: boolean;
  error?: string;
  needsResume?: boolean;
  retryable?: boolean;
  noDescription?: boolean;
}

export interface RewriteSession {
  presets: string[];
  togglePreset: (id: string) => void;
  ask: string;
  setAsk: (s: string) => void;

  busy: boolean;
  res: RewriteResponse | null;
  run: () => Promise<void>;

  /** Lines the person has confirmed, by their exact text. */
  confirmed: Set<string>;
  confirm: (line: string) => void;
  unconfirm: (line: string) => void;
  /** Every line still waiting on a yes or a no. */
  open: CheckedLine[];
  /** Questions the person answered "no" to, so they stop being asked. */
  declined: Set<string>;
  decline: (line: string) => void;

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
  const [presets, setPresets] = useState<string[]>(['plain', 'depth', 'keywords']);
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RewriteResponse | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [declined, setDeclined] = useState<Set<string>>(new Set());
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const togglePreset = (id: string) =>
    setPresets((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const run = useCallback(async () => {
    setBusy(true);
    setRes(null);
    setConfirmed(new Set());
    setDeclined(new Set());
    setReverted(new Set());
    setEdited(null);
    setError('');
    try {
      const r = await fetch('/api/tailor/rewrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobKey, presets, ask: ask.trim() || null }),
      });
      // Parsed whatever the status: every error this route returns carries a
      // sentence, and "something went wrong" would throw away the useful part.
      setRes((await r.json().catch(() => ({}))) as RewriteResponse);
    } catch {
      setRes({ error: 'could not reach the server — check your connection and try again' });
    } finally {
      setBusy(false);
    }
  }, [jobKey, presets, ask]);

  const rewrite = res?.rewrite ?? null;

  const open: CheckedLine[] = rewrite
    ? [rewrite.summary, ...rewrite.skills, ...rewrite.companies.flatMap((c) => c.lines)].filter(
        (l) => l.verdict === 'ask' && !confirmed.has(l.text) && !declined.has(l.text),
      )
    : [];

  const confirm = (line: string) =>
    setConfirmed((c) => {
      const next = new Set(c);
      next.add(line);
      return next;
    });
  const unconfirm = (line: string) =>
    setConfirmed((c) => {
      const next = new Set(c);
      next.delete(line);
      return next;
    });
  const decline = (line: string) =>
    setDeclined((d) => {
      const next = new Set(d);
      next.add(line);
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

  const built =
    rewrite && res?.shape ? assembleRewrite(rewrite, res.shape, confirmed, reverted) : '';

  // A hand edit wins over the assembled document until it is cleared. Assembling
  // over the top would throw away what somebody typed the moment they reverted an
  // unrelated line, which is the bug the old screen had.
  const document_ = edited ?? built;

  const original = res?.shape
    ? [
        res.shape.name,
        ...res.shape.contact,
        '',
        ...res.shape.summary,
        '',
        ...(res.shape.skills.length ? ['TECHNICAL SKILLS', ...res.shape.skills, ''] : []),
        ...(res.shape.companies.length
          ? [
              'PROFESSIONAL EXPERIENCE',
              ...res.shape.companies.flatMap((c) => [
                c.header,
                ...(c.role ? [c.role] : []),
                ...c.bullets.map((b) => `\u00b7 ${b}`),
                '',
              ]),
            ]
          : []),
        ...(res.shape.education.length ? ['EDUCATION', ...res.shape.education] : []),
      ]
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : '';

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
    presets,
    togglePreset,
    ask,
    setAsk,
    busy,
    res,
    run,
    confirmed,
    confirm,
    unconfirm,
    open,
    declined,
    decline,
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
