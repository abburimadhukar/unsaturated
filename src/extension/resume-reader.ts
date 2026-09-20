/**
 * The extension's "start from your résumé": a file in, a profile out.
 *
 * Built into extension/src/resume.js by scripts/build-extension.mjs, so the
 * extension ships the SAME code the website uses to read résumés — the .docx
 * unzipper, the PDF line rebuilder, the converter-damage repair — rather than a
 * second copy that drifts.
 *
 * Runs on the options page, inside the extension. Nothing leaves the browser:
 * pdf.js is bundled with the extension and reads the file in place.
 */

import { linesFromItems, type TextItem } from '../ui/pdf-lines.js';
import { cleanResumeText } from '../ui/resume-clean.js';
import { docxText, xmlToText, stripControlChars, zipEntry } from '../ui/resume-read-core.js';
import { profileFromResume, type ResumeProfile } from '../ui/resume-profile.js';

export interface ReadResult {
  text: string;
  links: string[];
  profile: ResumeProfile;
  /** Said to the person when little or nothing could be read. */
  warning: string | null;
}

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: unknown[] }>;
        getAnnotations(): Promise<{ subtype?: string; url?: string; unsafeUrl?: string }[]>;
      }>;
      destroy(): Promise<void>;
    }>;
  };
}

/**
 * Where pdf.js and its worker live. Passed in rather than imported, because in
 * the extension they are separate files addressed by chrome.runtime.getURL.
 */
export interface PdfLocation {
  lib: string;
  worker: string;
}

async function pdfRead(buf: ArrayBuffer, where: PdfLocation): Promise<{ text: string; links: string[] }> {
  const pdfjs = (await import(/* @vite-ignore */ where.lib)) as PdfJs;
  pdfjs.GlobalWorkerOptions.workerSrc = where.worker;
  // No eval: an extension page's security policy forbids it, and reading text
  // does not need the font-compiling path that uses it.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const pages: string[] = [];
  const links: string[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 10); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(linesFromItems(content.items as TextItem[]));
    // The address behind a word: "LinkedIn" printed, the URL only in the link.
    for (const a of await page.getAnnotations()) {
      const url = a.url || a.unsafeUrl;
      if (a.subtype === 'Link' && url) links.push(url);
    }
  }
  await doc.destroy();
  return { text: pages.join('\n\n'), links };
}

async function docxRead(buf: ArrayBuffer): Promise<{ text: string; links: string[] }> {
  const text = xmlToText(await docxText(buf));
  const rels = (await zipEntry(buf, 'word/_rels/document.xml.rels')) ?? '';
  const links = [...rels.matchAll(/Target="(https?:[^"]+|mailto:[^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
  return { text, links };
}

export async function readResume(file: File, where: PdfLocation, today = new Date()): Promise<ReadResult> {
  const name = file.name.toLowerCase();
  const empty = (warning: string): ReadResult => ({
    text: '',
    links: [],
    profile: profileFromResume('', { today }),
    warning,
  });

  let raw: { text: string; links: string[] };
  try {
    if (name.endsWith('.pdf')) raw = await pdfRead(await file.arrayBuffer(), where);
    else if (name.endsWith('.docx')) raw = await docxRead(await file.arrayBuffer());
    else if (name.endsWith('.txt') || name.endsWith('.md')) raw = { text: await file.text(), links: [] };
    else if (name.endsWith('.doc')) {
      return empty('Old .doc files cannot be read here. The file is kept for attaching; save it as PDF or .docx to have your details read from it.');
    } else return empty('Use a PDF or .docx file to have your details read from it.');
  } catch (err) {
    return empty(`Could not read that file (${err instanceof Error ? err.message : String(err)}). It is kept for attaching; fill your details in by hand.`);
  }

  const text = cleanResumeText(stripControlChars(raw.text)).text;
  const profile = profileFromResume(text, { links: raw.links, today });
  const warning = text.length < 200
    ? 'Almost no text came out of that file — it may be a scanned image. It is kept for attaching; fill your details in by hand.'
    : null;
  return { text, links: raw.links, profile, warning };
}
