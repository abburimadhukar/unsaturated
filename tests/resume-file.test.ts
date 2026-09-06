import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isAcceptedFile, MAX_RESUME_BYTES, ACCEPTED } from '../src/ui/resume-file.js';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

/**
 * Resume uploads, and the sticky-layer arithmetic that put the search box
 * underneath the family tabs.
 */

// ---------------------------------------------------------------------------
// The sticky stack
// ---------------------------------------------------------------------------

test('the sidebar clears both sticky layers above it', () => {
  // Three sticky layers cannot be kept in step by memory. The header is 56px
  // and the family bar sits on top of it; the sidebar was pinned at 78px, which
  // is INSIDE the family bar — and since that bar carries z-index 25 and a
  // blur, the search field slid behind it and became unreadable the moment the
  // page scrolled.
  const num = (re: RegExp) => {
    const m = re.exec(css);
    assert.ok(m, `could not find ${re}`);
    return Number(m[1]);
  };

  const headerHeight = num(/header\s*\{[^}]*?height:\s*(\d+)px/s);
  const familiesTop = num(/\.families\s*\{[^}]*?top:\s*(\d+)px/s);
  const familiesPad = num(/\.families\s*\{[^}]*?padding:\s*(\d+)px/s);
  const sidebarTop = num(/\.sidebar\s*\{[^}]*?top:\s*(\d+)px/s);

  assert.equal(familiesTop, headerHeight, 'the family bar must sit directly under the header');

  // Its buttons are 13px text with 5px padding and a 1px border each side, so
  // the bar is its own padding plus roughly 32px of control.
  const familiesHeight = familiesPad * 2 + 32;
  const familiesBottom = familiesTop + familiesHeight;

  assert.ok(
    sidebarTop >= familiesBottom,
    `sidebar pins at ${sidebarTop}px, inside the family bar which ends at ~${familiesBottom}px`,
  );
  // And with visible breathing room rather than flush against it.
  assert.ok(
    sidebarTop - familiesBottom >= 8,
    `only ${sidebarTop - familiesBottom}px between the family tabs and the search box`,
  );
});

test('the sidebar can still be scrolled to its end', () => {
  // It is pinned, so the page scrolling behind it never moves it — without a
  // height cap the lower filters are unreachable. The cap has to move with the
  // offset or the bottom of the sidebar falls off the screen.
  const top = Number(/\.sidebar\s*\{[^}]*?top:\s*(\d+)px/s.exec(css)![1]);
  const cap = Number(/\.sidebar\s*\{[^}]*?max-height:\s*calc\(100vh - (\d+)px\)/s.exec(css)![1]);
  assert.ok(cap >= top, `a sidebar pinned at ${top}px cannot be capped at 100vh-${cap}px`);
});

// ---------------------------------------------------------------------------
// Which files are accepted
// ---------------------------------------------------------------------------

for (const name of ['cv.pdf', 'Resume.PDF', 'my resume.docx', 'notes.txt', 'readme.md']) {
  test(`"${name}" is accepted`, () => assert.equal(isAcceptedFile(name), true));
}

for (const name of ['resume.doc', 'resume.pages', 'photo.png', 'archive.zip', 'resume', 'resume.pdf.exe']) {
  test(`"${name}" is refused`, () => assert.equal(isAcceptedFile(name), false));
}

test('the picker offers exactly what the code accepts', () => {
  // A file input advertising a type the reader cannot handle is a promise the
  // page does not keep.
  for (const ext of ACCEPTED.split(',')) {
    assert.equal(isAcceptedFile(`resume${ext}`), true, `${ext} is offered but refused`);
  }
});

test('the browser and the server agree on the size limit', () => {
  const route = readFileSync(
    new URL('../app/api/profile/resume-file/route.ts', import.meta.url),
    'utf8',
  );
  const serverMax = /const MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(route);
  assert.ok(serverMax);
  assert.equal(MAX_RESUME_BYTES, Number(serverMax[1]) * 1024 * 1024);

  // And the bucket must not be the one that refuses first — a storage-level
  // rejection surfaces as an opaque failure rather than the clear message the
  // route already writes.
  const sql = readFileSync(
    new URL('../src/db/migrations/2026-09-06-resume-file.sql', import.meta.url),
    'utf8',
  );
  const bucketLimit = /file_size_limit[\s\S]*?(\d{7})/.exec(sql);
  assert.ok(bucketLimit, 'the bucket should declare a size limit');
  assert.ok(Number(bucketLimit[1]) >= MAX_RESUME_BYTES);
});

// ---------------------------------------------------------------------------
// The storage route
// ---------------------------------------------------------------------------

test('resume files are only ever stored for a signed-in account', () => {
  const route = readFileSync(
    new URL('../app/api/profile/resume-file/route.ts', import.meta.url),
    'utf8',
  );
  // An anonymous visitor is a cookie, and a cookie can be cleared. Storing
  // someone's CV against one means a file nobody can reach and nobody can ask
  // us to delete.
  const handlers = route.split(/export async function /).slice(1);
  assert.equal(handlers.length, 3, 'expected POST, GET and DELETE');
  for (const h of handlers) {
    assert.match(h, /if \(!session\?\.user\)/, `a handler is missing the sign-in check`);
  }
});

test('the uploaded filename never becomes a storage path', () => {
  const route = readFileSync(
    new URL('../app/api/profile/resume-file/route.ts', import.meta.url),
    'utf8',
  );
  // A name arriving from a browser is not something to build a key out of:
  // "../../other-user/resume.pdf" is a filename too.
  const pathFn = route.slice(route.indexOf('function pathFor'), route.indexOf('export async function POST'));
  assert.match(pathFn, /replace\(\/\[\^A-Za-z0-9:_-\]\/g, '_'\)/);
  assert.doesNotMatch(pathFn, /file\.name/);
});

test('the bucket is private and downloads are signed', () => {
  const sql = readFileSync(
    new URL('../src/db/migrations/2026-09-06-resume-file.sql', import.meta.url),
    'utf8',
  );
  // A public bucket puts every CV behind a guessable URL with no sign-in.
  assert.match(sql, /'resumes',\s*\n\s*false,/);
  assert.match(sql, /set public = false/);

  const route = readFileSync(
    new URL('../app/api/profile/resume-file/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /createSignedUrl\(profile\.resumePath, 60\)/);
});

test('removing the file does not claim the skills went with it', () => {
  const page = readFileSync(new URL('../app/account/page.tsx', import.meta.url), 'utf8');
  // They do not, and saying otherwise would be untrue.
  assert.match(page, /extracted skills are unchanged/);
});

test('every profile writer preserves the fields it does not own', () => {
  // Three write paths share one row — name, resume text, resume file. Listing
  // fields by hand is how one silently drops another's work, which is exactly
  // how the name was lost before.
  const store = readFileSync(new URL('../src/state/store.ts', import.meta.url), 'utf8');
  const writers = ['setProfileFromResume', 'setProfileSkills', 'setProfileName', 'setResumeFile', 'clearResumeFile'];
  for (const fn of writers) {
    const at = store.indexOf(`export async function ${fn}`);
    assert.notEqual(at, -1, `${fn} is missing`);
    const body = store.slice(at, store.indexOf('await persistProfile', at));
    assert.match(body, /\.\.\.current,/, `${fn} must spread the current profile, not enumerate it`);
  }
});
