import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bytes that must never appear in a source file.
 *
 * A generated edit wrote literal 0x08 bytes where regex word boundaries were
 * meant, three separate times: the payroll rule read /<BS>(payroll|…)<BS>/ and
 * matched nothing, the GTM rules the same, and the Personio job counter the
 * same again. Each cost an hour, because the file LOOKS correct in every
 * terminal — a backspace renders by eating the character before it, so
 * `/\bfoo/` and `/<BS>foo/` are indistinguishable by eye.
 *
 * Only a byte-level check finds them, so here it is, run on every commit.
 */

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SKIP = new Set(['node_modules', '.next', '.open-next', '.git', 'dist']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|css|sql|mjs|json|ya?ml)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = sourceFiles(ROOT);

test('the source tree is not empty (the walker actually found files)', () => {
  // A guard that silently scans nothing passes forever and protects nothing.
  assert.ok(files.length > 40, `only found ${files.length} files — the walk is broken`);
});

test('no source file contains a literal backspace', () => {
  const bad: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    if (buf.includes(0x08)) bad.push(f.replace(ROOT, ''));
  }
  assert.deepEqual(bad, [],
    `0x08 found in: ${bad.join(', ')} — almost certainly a \\b that lost its backslash`);
});

test('no source file contains other invisible control characters', () => {
  // NUL, vertical tab, form feed, escape and the C0 range generally. None has
  // any business in TypeScript, CSS or SQL, and each is invisible in an editor.
  const bad: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    for (const byte of buf) {
      // Tab, newline and carriage return are the legitimate ones.
      if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        bad.push(`${f.replace(ROOT, '')} (0x${byte.toString(16).padStart(2, '0')})`);
        break;
      }
    }
  }
  assert.deepEqual(bad, [], `control characters in: ${bad.join(', ')}`);
});
