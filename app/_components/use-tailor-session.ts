'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  diffHandEdits,
  handEditedLines,
  replayHandEdits,
  type HandEdit,
} from '../../src/tailor/hand-edits.js';
import { docxBlob, docxFileName } from '../../src/ui/docx.js';
import { readResume } from '../../src/ui/resume-render.js';
import type { Coverage, DomainRead, SkillMatch } from '../../src/tailor/analysis.js';
import type { CheckedEdit } from './tailor-parts.js';

/**
 * Everything the tailoring screens DO, with none of what they look like.
 *
 * Two screens run this: the panel inside a feed card and the workspace at
 * /tailor. Both suggest changes against the same posting, accept them one at a
 * time, splice them into the same stored CV and download the same files. Only
 * the arrangement differs.
 *
 * Kept in one place so the arrangement is the only thing that differs. Two copies
 * of this logic would mean two answers to "is this change in my resume?", and the
 * bug would surface as a download that does not match the screen.
 */

export interface TailorResponse {
  edits?: CheckedEdit[];
  gaps?: string[];
  /** The analysis. Checked server-side before it ever reaches here. */
  requirements?: SkillMatch[];
  coverage?: Coverage;
  coverageNote?: string;
  domain?: DomainRead;
  accepted?: number;
  flagged?: number;
  rejected?: number;
  applied?: string[];
  note?: string;
  model?: string;
  via?: string;
  /** The posting, so it can be read beside the resume. Never stored. */
  jobDescription?: string;
  jobDescriptionTruncated?: boolean;
  error?: string;
  needsResume?: boolean;
  retryable?: boolean;
  noDescription?: boolean;
  /** True when a person has to fix something — a bad key, no credit. */
  needsAttention?: boolean;
}

interface ApplyResponse {
  text?: string;
  applied?: number;
  refused?: { original: string; why: string }[];
  error?: string;
  needsResume?: boolean;
}

export interface Built {
  text: string;
  applied: number;
  refused: { original: string; why: string }[];
}

export interface TailorSession {
  chosen: string[];
  toggleChip: (id: string) => void;
  custom: string;
  setCustom: (s: string) => void;

  busy: boolean;
  res: TailorResponse | null;
  run: () => Promise<void>;

  /** Every edit worth showing, paired with its index into res.edits. */
  usable: { c: CheckedEdit; i: number }[];
  discarded: CheckedEdit[];
  decided: Record<number, 'taken' | 'skipped'>;
  take: (i: number) => void;
  skip: (i: number) => void;
  takenEdits: { original: string; replacement: string }[];
  /** Suggested, not yet accepted or skipped. The number that actually remains. */
  undecided: number;

  /** The CV as it currently stands. Present from load, before anything is run. */
  built: Built | null;
  building: boolean;
  buildError: string;
  setBuildError: (s: string) => void;
  /** True until the first load of the untouched resume finishes. */
  loadingResume: boolean;
  /** Set when there is no CV on the account at all. */
  noResume: boolean;
  editText: (s: string) => void;
  /** Lines the person typed themselves, so the sheet can mark them. */
  handEdited: Set<number>;
  /** How many of their own edits could not be put back, and why. */
  handEditsLost: number;
  clearHandEdits: () => void;

  saving: boolean;
  copied: boolean;
  copy: () => void;
  saveDocx: () => Promise<void>;
  saveOriginalEdited: () => Promise<void>;
  printable: () => void;
}

/** The splice runs on the server; this debounce stops a burst of clicks queueing. */
const REBUILD_MS = 180;

async function postApply(
  edits: { original: string; replacement: string }[],
): Promise<{ ok: boolean; body: ApplyResponse }> {
  const r = await fetch('/api/tailor/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edits }),
  });
  const body = (await r.json().catch(() => ({}))) as ApplyResponse;
  return { ok: r.ok && typeof body.text === 'string', body };
}

export function useTailorSession(jobKey: string, jobTitle: string): TailorSession {
  const [chosen, setChosen] = useState<string[]>(['mirror', 'lead']);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TailorResponse | null>(null);
  const [decided, setDecided] = useState<Record<number, 'taken' | 'skipped'>>({});

  const [built, setBuilt] = useState<Built | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState('');
  const [loadingResume, setLoadingResume] = useState(true);
  const [noResume, setNoResume] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  /**
   * What the person typed, as operations rather than as a document.
   *
   * The CV is rebuilt from the stored original on every accept and skip, so a
   * hand-edited document is overwritten by the next click. Holding the edits as
   * operations lets them be replayed on top of each rebuild — see
   * src/tailor/hand-edits.ts.
   */
  const [hand, setHand] = useState<HandEdit[]>([]);
  const [handLost, setHandLost] = useState(0);

  const toggleChip = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  const edits = res?.edits ?? [];
  const usable = edits.map((c, i) => ({ c, i })).filter(({ c }) => c.verdict !== 'rejected');
  const discarded = edits.filter((c) => c.verdict === 'rejected');

  /**
   * The accepted edits, as pairs.
   *
   * The pair and not just the replacement: the server splices by finding the
   * original, so a list of new lines on its own would be unusable.
   */
  const takenEdits = usable
    .filter(({ i }) => decided[i] === 'taken')
    .map(({ c }) => ({ original: c.edit.original, replacement: c.edit.replacement }));

  const undecided = usable.filter(({ i }) => !decided[i]).length;

  /**
   * The CV, rebuilt from the stored original every time the selection changes.
   *
   * ALWAYS FROM THE ORIGINAL, NEVER FROM THE LAST RESULT
   *
   * Which is what makes un-accepting a change possible at all. Splicing onto the
   * previous output would make every acceptance permanent — there is no reliable
   * way to un-splice a sentence once a later edit has overlapped it. Sending the
   * current selection against the untouched original means the document is a pure
   * function of what is ticked, and "Skip" after "Use this" genuinely puts the
   * line back.
   *
   * The cost is a request per click. It buys re-verification of every edit on
   * every build — the promise has to be a property of the document rather than of
   * one request path behaving well — and the route spends nothing: one narrow read
   * and some string work.
   */
  const key = JSON.stringify(takenEdits);
  const latest = useRef(0);

  useEffect(() => {
    const chosenEdits = JSON.parse(key) as { original: string; replacement: string }[];
    const run = ++latest.current;
    let live = true;

    // Only the empty first load is silent. Once there is a document on screen,
    // replacing it with a spinner on every click would make the page flicker
    // through a blank state the whole time somebody is working.
    if (chosenEdits.length > 0) setBuilding(true);
    // The document is about to change, so "Copied" stops being true about it.
    setCopied(false);

    const t = setTimeout(() => {
      void (async () => {
        try {
          const { ok, body } = await postApply(chosenEdits);
          // A slow earlier request must not overwrite a newer result.
          if (!live || run !== latest.current) return;
          if (!ok) {
            if (body.needsResume) setNoResume(true);
            // A failed REBUILD keeps the document that is already on screen; only
            // a failed first load has nothing to show.
            else setBuildError(body.error ?? 'could not build your resume — try again');
            return;
          }
          setNoResume(false);
          setBuildError('');
          setBuilt({
            text: body.text ?? '',
            applied: body.applied ?? 0,
            refused: body.refused ?? [],
          });
        } catch {
          if (live && run === latest.current) {
            setBuildError('could not reach the server — check your connection');
          }
        } finally {
          if (live && run === latest.current) {
            setBuilding(false);
            setLoadingResume(false);
          }
        }
      })();
    }, chosenEdits.length === 0 ? 0 : REBUILD_MS);

    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);

  const run = useCallback(async () => {
    setBusy(true);
    setRes(null);
    setDecided({});
    try {
      const r = await fetch('/api/tailor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobKey, chips: chosen, custom: custom.trim() || null }),
      });
      // Parsed whatever the status. Every error this route returns carries a
      // sentence in `error`, and showing "something went wrong" instead would
      // throw away the only useful part of the response.
      const body = (await r.json().catch(() => ({}))) as TailorResponse;
      setRes(body);
    } catch {
      setRes({ error: 'could not reach the server — check your connection and try again' });
    } finally {
      setBusy(false);
    }
  }, [jobKey, chosen, custom]);

  const take = (i: number) => setDecided((d) => ({ ...d, [i]: 'taken' }));
  const skip = (i: number) => setDecided((d) => ({ ...d, [i]: 'skipped' }));

  /**
   * Hand editing.
   *
   * The new text is not stored as the document. It is DIFFED against the one on
   * screen, and the difference is kept as operations anchored to line content —
   * so when the next accept rebuilds the document from scratch, the person's
   * sentences go back where they belong instead of disappearing.
   */
  const editText = (next: string) => {
    if (!built) return;
    setHand(diffHandEdits(built.text, next));
  };

  const clearHandEdits = () => {
    setHand([]);
    setHandLost(0);
  };

  // The document as shown and as downloaded: the verified rebuild, with the
  // person's own words on top. One value, so the screen and every export agree.
  const replayed = built ? replayHandEdits(built.text, hand) : null;
  const shown: Built | null =
    built && replayed ? { ...built, text: replayed.text } : built;
  const handEdited = replayed ? handEditedLines(replayed.text, hand) : new Set<number>();

  // Reported rather than forced somewhere approximate: an edit whose line a
  // suggestion has since replaced has nowhere correct to go. In an effect and not
  // in the render body, because setting state while rendering is how a render
  // loop starts.
  const lostNow = replayed ? replayed.lost.length : 0;
  useEffect(() => {
    setHandLost(lostNow);
  }, [lostNow]);

  const copy = () => {
    if (!shown) return;
    void navigator.clipboard?.writeText(shown.text);
    setCopied(true);
  };

  /**
   * The .docx, built in the page.
   *
   * Nothing is uploaded and nothing is stored to produce it: the text is already
   * here, and the browser's own deflater does the compression — see
   * src/ui/docx.ts, which is the mirror of the unzipper the upload path uses.
   */
  const saveDocx = async () => {
    if (!shown) return;
    setSaving(true);
    try {
      const blob = await docxBlob(shown.text);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = docxFileName(jobTitle);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setBuildError('could not build the .docx — copy the text instead');
    } finally {
      setSaving(false);
    }
  };

  /**
   * The person's own file, edited.
   *
   * Preferred over the generated document whenever they uploaded a .docx, because
   * it keeps their layout. The server does the editing — the original lives in a
   * private bucket and the browser has no copy.
   */
  const saveOriginalEdited = async () => {
    setSaving(true);
    setBuildError('');
    if (hand.length > 0) {
      // Said before the file downloads, not after. This export edits the person's
      // OWN .docx on the server, which re-verifies every edit it applies — and
      // their own sentences are not the model's claims to verify, so they cannot
      // travel that path. The clean .docx and the PDF do contain them.
      setBuildError(
        `Your ${hand.length} hand-written change${hand.length === 1 ? '' : 's'} are not in this file — it keeps your original layout, so only the accepted suggestions go in. "Clean .docx" and "Save as PDF" contain everything you see on screen.`,
      );
    }
    try {
      const r = await fetch('/api/tailor/docx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ edits: takenEdits }),
      });
      if (!r.ok) {
        // Every refusal from this route carries a sentence that says what to do —
        // upload a file, upload the .docx rather than the PDF, re-save it.
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        setBuildError(b.error ?? 'could not edit your file');
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // The filename the server chose, which is the person's own name for it.
      const disp = r.headers.get('content-disposition') ?? '';
      a.download = /filename="([^"]+)"/.exec(disp)?.[1] ?? docxFileName(jobTitle);
      a.click();
      URL.revokeObjectURL(url);

      const missed = Number(r.headers.get('x-edits-missed') ?? '0');
      if (missed > 0) {
        setBuildError(
          `${missed} change${missed === 1 ? '' : 's'} could not be found in your file, so ${missed === 1 ? 'it was' : 'they were'} left out. The rest are in the download.`,
        );
      }
    } catch {
      setBuildError('could not reach the server — check your connection');
    } finally {
      setSaving(false);
    }
  };

  /**
   * PDF, via the browser's own print dialogue.
   *
   * NOT a hand-rolled PDF, deliberately. Constructing one means laying out the
   * text layer by hand, and getting the spacing wrong produces a file that looks
   * right and extracts as "Ranmulti-regionAWS" — which is the failure that
   * matters, because the first reader of a resume is usually a parser. The browser
   * handles fonts, kerning and the text layer properly and for free.
   *
   * A separate window rather than a print stylesheet over this page: the workspace
   * is a fixed-height shell with two scrolling panes, and hiding all of it
   * reliably takes more CSS than it takes to render the one thing being printed.
   */
  const printable = () => {
    if (!shown) return;
    const w = window.open('', '_blank', 'width=820,height=1000');
    if (!w) {
      setBuildError('your browser blocked the print window — allow pop-ups, or download the .docx');
      return;
    }

    // Escaped rather than inserted. It is the person's own CV, but it is still
    // text going into markup, and "<" in "C++ <algorithm>" would eat the rest.
    const esc = (t: string) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // The SAME block reading the preview uses, so what prints is what was on
    // screen. Printing plain pre-wrapped text while the preview showed headings
    // and bullets would make the preview a lie about the PDF.
    const body = readResume(shown.text)
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
        'p{margin:0 0 2pt}' +
        '.bullet{display:flex;gap:6pt}.m{flex:0 0 auto}' +
        '.gap{height:7pt}' +
        // Nothing should be marked in the printed copy. The highlight exists to
        // help somebody review on screen; an employer receiving a CV with three
        // lines shaded would wonder what was wrong with them.
        '</style>' +
        `</head><body>${body}</body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };

  return {
    chosen,
    toggleChip,
    custom,
    setCustom,
    busy,
    res,
    run,
    usable,
    discarded,
    decided,
    take,
    skip,
    takenEdits,
    undecided,
    built: shown,
    building,
    buildError,
    setBuildError,
    loadingResume,
    noResume,
    editText,
    handEdited,
    handEditsLost: handLost,
    clearHandEdits,
    saving,
    copied,
    copy,
    saveDocx,
    saveOriginalEdited,
    printable,
  };
}
