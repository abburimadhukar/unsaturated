/**
 * Editing somebody's own .docx in place, keeping everything else byte for byte.
 *
 * WHY THIS REPLACES GENERATING A DOCUMENT
 *
 * docx.ts builds a clean resume from plain text. It produces a correct, readable,
 * ATS-safe file — and it is not the person's resume. Their fonts, their spacing,
 * their section order, the layout they spent an evening on: all of it replaced by
 * a default. For somebody who pasted text there was nothing to lose. For somebody
 * who uploaded a designed document it is the wrong trade entirely.
 *
 * So this takes their file and changes only the sentences they accepted.
 *
 * HOW A .docx MAKES THAT POSSIBLE
 *
 * The visible text lives in word/document.xml as a sequence of <w:t> elements.
 * Everything that makes the document look like itself — styles.xml, theme, fonts,
 * numbering, images, headers — lives in other entries, and none of them has to be
 * touched. Unchanged entries are copied across as their ALREADY-COMPRESSED bytes,
 * never decompressed and re-deflated, so an embedded font or image cannot be
 * altered by a rounding error in this code.
 *
 * THE PART THAT MAKES IT FIDDLY
 *
 * A sentence is rarely one <w:t>. Word splits runs at every formatting boundary,
 * and also at nothing in particular — a spell-check boundary, an editing session,
 * a tracked change long since accepted. One bullet is routinely:
 *
 *   <w:r><w:t>Managed cloud infra</w:t></w:r>
 *   <w:r><w:t>structure for the </w:t></w:r>
 *   <w:r><w:rPr><w:b/></w:rPr><w:t>platform team</w:t></w:r>
 *
 * Searching any single element for the sentence finds nothing. So the elements are
 * concatenated into one string with a map back to where each character came from,
 * the sentence is found in THAT, and the replacement is written into the first
 * element of the span while the rest are emptied.
 *
 * Which means the replacement inherits the formatting of the first run it lands
 * in. A bullet that was half bold comes back entirely un-bold, or entirely bold,
 * depending where it started. That is a real and visible limitation, and it is the
 * right one to accept: the alternative is deciding which words of a new sentence
 * deserve which of the old sentence's formatting, and any rule for that is a
 * guess about intent.
 */

/** A ZIP entry, kept as it was found. */
export interface ZipEntry {
  name: string;
  /** Exactly the bytes from the archive — still compressed if it was. */
  data: Uint8Array;
  method: number;
  crc: number;
  uncompressedSize: number;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8);
}
function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

/**
 * Every entry, read through the central directory rather than by walking the
 * local headers.
 *
 * The central directory is the authority on what a ZIP contains: local headers can
 * carry zero sizes with the real ones in a trailing data descriptor, which is how
 * a streamed archive is written and which a naive forward walk reads as an empty
 * file. Word itself writes ordinary archives, but a CV that has been through
 * Google Docs or a conversion service may not have been written by Word.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  // The EOCD sits at the end, after a comment of unknown length.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65_536; i--) {
    if (u32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a .docx — no zip directory found');

  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];

  for (let n = 0; n < count; n++) {
    if (u32(bytes, at) !== CENTRAL_SIG) throw new Error('damaged zip directory');
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const compressedSize = u32(bytes, at + 20);
    const uncompressedSize = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localAt = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    if (u32(bytes, localAt) !== LOCAL_SIG) throw new Error(`damaged entry: ${name}`);
    const localNameLen = u16(bytes, localAt + 26);
    const localExtraLen = u16(bytes, localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;

    entries.push({
      name,
      data: bytes.subarray(dataAt, dataAt + compressedSize),
      method,
      crc,
      uncompressedSize,
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return data;
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!DS) throw new Error('this browser cannot read compressed .docx files');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(data: Uint8Array): Promise<{ data: Uint8Array; method: number }> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return { data, method: 0 };
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS('deflate-raw'));
    return { data: new Uint8Array(await new Response(stream).arrayBuffer()), method: 8 };
  } catch {
    return { data, method: 0 };
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

/** One <w:t> element, and where its text sits in the XML. */
interface TextNode {
  /** Index of the first character of the text content. */
  start: number;
  /** Index just past the last character. */
  end: number;
  text: string;
  /** Index of the '<' that opens this element, so the tag can be rewritten. */
  tagStart: number;
}

/**
 * Every <w:t> element in document order.
 *
 * A regex and not an XML parser. The shape being matched is narrow and fixed —
 * Word writes <w:t> and <w:t xml:space="preserve"> and nothing else — and the
 * alternative is pulling a parser into a browser bundle to find one element type
 * and then serialise the whole document back, which risks changing parts of the
 * XML that nothing asked to change.
 */
export function textNodes(xml: string): TextNode[] {
  const out: TextNode[] = [];
  const re = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const whole = m[0];
    const inner = m[2] ?? '';
    const start = m.index + whole.length - inner.length - '</w:t>'.length;
    out.push({ tagStart: m.index, start, end: start + inner.length, text: inner });
  }
  return out;
}

/** XML entities back to characters, for matching against plain text. */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    // Last, or an escaped entity in the source becomes a real one.
    .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * The document's visible text, with a map back to the XML.
 *
 * Whitespace is collapsed as it is joined, because the text a person's edits were
 * computed from came out of an extractor that collapsed it too. Matching on the
 * raw run text would fail on a line that happens to be split across a newline in
 * the XML — which is most of them.
 */
interface Flattened {
  /** The visible text, whitespace collapsed. */
  text: string;
  /** For each character of `text`, which node it came from and the offset in it. */
  map: { node: number; offset: number }[];
}

export function flatten(nodes: readonly TextNode[]): Flattened {
  let text = '';
  const map: { node: number; offset: number }[] = [];
  for (let n = 0; n < nodes.length; n++) {
    const raw = unescapeXml(nodes[n]!.text);
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (/\s/.test(ch)) {
        // One space for any run of whitespace, and never a leading one.
        if (text.length === 0 || text.endsWith(' ')) continue;
        text += ' ';
      } else {
        text += ch;
      }
      map.push({ node: n, offset: i });
    }
  }
  return { text, map };
}

export interface DocxEdit {
  original: string;
  replacement: string;
}

export interface EditResult {
  bytes: Uint8Array;
  applied: number;
  /** Edits whose text could not be located in the document. */
  missed: DocxEdit[];
}

/** Whitespace collapsed, for comparing a quoted line with the document. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The person's .docx with the accepted sentences replaced.
 *
 * Everything not named by an edit is returned exactly as it arrived, including
 * every other entry in the archive as its original compressed bytes.
 */
export async function editDocx(
  original: Uint8Array,
  edits: readonly DocxEdit[],
): Promise<EditResult> {
  const entries = readZip(original);
  const docIndex = entries.findIndex((e) => e.name === 'word/document.xml');
  if (docIndex < 0) throw new Error('that .docx has no word/document.xml');

  const docBytes = await inflateRaw(entries[docIndex]!.data, entries[docIndex]!.method);
  let xml = new TextDecoder().decode(docBytes);

  const missed: DocxEdit[] = [];
  let applied = 0;

  // Edits are applied one at a time, re-reading the XML each round. Slower, and
  // the reason is correctness: every replacement moves the offsets of everything
  // after it, so a single pass over one set of positions would write the second
  // edit into the wrong place once the first had changed the length.
  for (const edit of edits) {
    const wanted = collapse(edit.original);
    if (!wanted) {
      missed.push(edit);
      continue;
    }

    const nodes = textNodes(xml);
    const flat = flatten(nodes);
    const at = flat.text.indexOf(wanted);
    if (at < 0) {
      missed.push(edit);
      continue;
    }

    const from = flat.map[at]!;
    const to = flat.map[at + wanted.length - 1]!;

    // Rebuilt back to front, so the earlier splice's offsets stay valid.
    const first = nodes[from.node]!;
    const last = nodes[to.node]!;

    if (from.node === to.node) {
      // One node: keep whatever sits either side of the matched text inside it.
      const raw = first.text;
      const before = raw.slice(0, indexOfRawOffset(raw, from.offset));
      const after = raw.slice(indexOfRawOffset(raw, to.offset) + 1);
      xml =
        xml.slice(0, first.start) + before + escapeXml(edit.replacement) + after + xml.slice(first.end);
    } else {
      // Several nodes. The replacement goes in the first, keeping its leading
      // remainder; the middle nodes are emptied; the last keeps its tail.
      const firstRaw = first.text;
      const lastRaw = last.text;
      const firstKeep = firstRaw.slice(0, indexOfRawOffset(firstRaw, from.offset));
      const lastKeep = lastRaw.slice(indexOfRawOffset(lastRaw, to.offset) + 1);

      // Last first, so the earlier edits do not shift its position.
      xml = xml.slice(0, last.start) + lastKeep + xml.slice(last.end);
      for (let n = to.node - 1; n > from.node; n--) {
        const mid = nodes[n]!;
        xml = xml.slice(0, mid.start) + xml.slice(mid.end);
      }
      xml =
        xml.slice(0, first.start) +
        firstKeep +
        escapeXml(edit.replacement) +
        xml.slice(first.end);
    }

    // The replacement may begin or end with a space, which Word discards unless
    // the element says otherwise. Applied to the element that now holds it.
    xml = preserveSpace(xml, first.tagStart);
    applied++;
  }

  const out = await rezipWith(entries, docIndex, new TextEncoder().encode(xml));
  return { bytes: out, applied, missed };
}

/**
 * Where a character sits in the RAW (still escaped) run text.
 *
 * The offsets in the map are indexes into the unescaped string. An entity is five
 * or six characters of XML for one character of text, so using an unescaped offset
 * against the raw string slices through the middle of "&amp;" and produces
 * malformed XML — a document Word refuses, from a CV that merely mentioned R&D.
 */
function indexOfRawOffset(raw: string, unescapedOffset: number): number {
  let seen = 0;
  for (let i = 0; i < raw.length; i++) {
    if (seen === unescapedOffset) return i;
    if (raw[i] === '&') {
      const end = raw.indexOf(';', i);
      // A bare ampersand is not legal XML, but a lone '&' in a malformed file
      // should not send this into the weeds.
      i = end > i && end - i <= 8 ? end : i;
    }
    seen++;
  }
  return raw.length;
}

/** Adds xml:space="preserve" to a <w:t> that does not have it. */
function preserveSpace(xml: string, tagStart: number): string {
  const close = xml.indexOf('>', tagStart);
  if (close < 0) return xml;
  const tag = xml.slice(tagStart, close + 1);
  if (tag.includes('xml:space')) return xml;
  return xml.slice(0, close) + ' xml:space="preserve"' + xml.slice(close);
}

/**
 * The archive written back out, with one entry's content replaced.
 *
 * Exported because the tests need to build a .docx whose text is split across
 * several runs — the normal Word shape, and the case this file exists for. The
 * writer in docx.ts puts each line in a single run, so a fixture made with it
 * would exercise none of the hard part.
 */
export async function rezipWith(
  entries: readonly ZipEntry[],
  replaceIndex: number,
  replacement: Uint8Array,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  let count = 0;

  const push32 = (a: number[], n: number) =>
    a.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const push16 = (a: number[], n: number) => a.push(n & 0xff, (n >>> 8) & 0xff);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    let data = e.data;
    let method = e.method;
    let crc = e.crc;
    let size = e.uncompressedSize;

    if (i === replaceIndex) {
      const deflated = await deflateRaw(replacement);
      data = deflated.data;
      method = deflated.method;
      crc = crc32(replacement);
      size = replacement.length;
    }

    const nameBytes = encoder.encode(e.name);
    const localStart = local.length;

    push32(local, LOCAL_SIG);
    push16(local, 20);
    push16(local, 0);
    push16(local, method);
    push16(local, 0);
    push16(local, 0x21);
    push32(local, crc);
    push32(local, data.length);
    push32(local, size);
    push16(local, nameBytes.length);
    push16(local, 0);
    for (const b of nameBytes) local.push(b);
    for (const b of data) local.push(b);

    push32(central, CENTRAL_SIG);
    push16(central, 20);
    push16(central, 20);
    push16(central, 0);
    push16(central, method);
    push16(central, 0);
    push16(central, 0x21);
    push32(central, crc);
    push32(central, data.length);
    push32(central, size);
    push16(central, nameBytes.length);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push16(central, 0);
    push32(central, 0);
    push32(central, localStart);
    for (const b of nameBytes) central.push(b);
    count++;
  }

  const eocd: number[] = [];
  push32(eocd, EOCD_SIG);
  push16(eocd, 0);
  push16(eocd, 0);
  push16(eocd, count);
  push16(eocd, count);
  push32(eocd, central.length);
  push32(eocd, local.length);
  push16(eocd, 0);

  return new Uint8Array([...local, ...central, ...eocd]);
}
