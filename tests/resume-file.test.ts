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

// ---------------------------------------------------------------------------
// Whose data is it
//
// Verified against the live database on 11 Sep 2026 with nothing but the
// publishable key — the one embedded in the deployed page and visible in any
// browser's network tab. All seven user_state rows came back, including three
// real people's full names and the size of their resumes:
//
//   select user_id, first_name, last_name, skills, resume_path from user_state
//   → 7 rows, HTTP 200, no authentication
//
// The cause was one policy, `using (true)`, and it could not simply be narrowed
// because store.ts read profiles with that same public key — closing the policy
// would have closed the app's own read. So the read moved to the secret key
// first. These tests exist so neither half drifts back.
// ---------------------------------------------------------------------------

test('PROFILES ARE READ WITH THE SECRET KEY, NEVER THE PUBLISHABLE ONE', () => {
  const src = readFileSync(new URL('../src/state/store.ts', import.meta.url), 'utf8');
  const load = src.slice(src.indexOf('async function load('), src.indexOf('function invalidate('));
  assert.match(load, /dbWrite\(\)/, 'the profile read must use the write client');
  assert.doesNotMatch(
    load,
    /\bdb\(\)/,
    'a single db() here republishes every name and every CV-derived skill',
  );
});

test('store.ts does not even import the public client any more', () => {
  // Dead imports are how this creeps back: the next person reaches for db()
  // because it is already in scope.
  const src = readFileSync(new URL('../src/state/store.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /import \{ db,/, 'db should not be imported at all');
  assert.match(src, /import \{ dbWrite \}/);
});

test('nothing outside the admin route reads these tables with the public key', () => {
  for (const f of ['../src/state/store.ts', '../app/api/me/route.ts', '../app/api/state/route.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    if (!/user_state|job_events/.test(src)) continue;
    assert.doesNotMatch(src, /\bdb\(\)\s*\n?\s*\.from\('(user_state|job_events)'\)/, f);
  }
});

// ---------------------------------------------------------------------------
// schema.sql must describe the table the code actually writes
//
// It has drifted twice. `boards.site` was added by a migration and never folded
// back in, so a fresh database came up with the old unique constraint and could
// hold one career site per employer — the exact bug that migration existed to
// fix. `user_state` was worse: first_name, last_name, resume_name, resume_size
// and resume_path were all live in production and absent from this file, so a
// fresh database was missing five columns the code writes on every save.
//
// The rule, stated once: a migration is not finished until schema.sql would
// produce the same table.
// ---------------------------------------------------------------------------

test('SCHEMA.SQL DECLARES EVERY user_state COLUMN THE CODE WRITES', () => {
  const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../src/state/store.ts', import.meta.url), 'utf8');

  const block = schema.slice(schema.indexOf('create table if not exists public.user_state'));
  const declared = block.slice(0, block.indexOf(');'));

  // The interface is the contract for what a write contains, so it is the list
  // to check against rather than one maintained by hand here.
  const iface = store.slice(
    store.indexOf('export interface UserStateRow'),
    store.indexOf('}', store.indexOf('export interface UserStateRow')),
  );
  const fields = [...iface.matchAll(/^\s{2}([a-z_]+)[?]?:/gm)].map((m) => m[1]!);
  assert.ok(fields.length >= 9, `expected the row interface to be found, got ${fields}`);

  // Line-by-line rather than a built regex. The first version of this test used
  // new RegExp with an escape inside a template literal, where \s is not a valid
  // escape and silently collapses to a literal "s" — so the pattern became
  // ^s{2}user_ids and the test failed against a file that was correct.
  const declaredNames = declared
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('--'))
    .map((l) => l.split(/\s+/)[0] ?? '');

  for (const f of fields) {
    assert.ok(
      declaredNames.includes(f),
      `schema.sql does not declare user_state.${f} — a fresh database would reject the write. ` +
        `It declares: ${declaredNames.filter(Boolean).join(', ')}`,
    );
  }
});

test('the vector type exists before any column declares it', () => {
  // schema.sql is applied top to bottom. halfvec used above `create extension`
  // is a file that fails on a fresh database and works on every existing one,
  // which is the hardest kind of breakage to notice.
  const lines = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8')
    .split(/\r?\n/)
    // Comments mention the type while explaining it; only code counts.
    .map((l) => l.replace(/--.*$/, ''));

  const ext = lines.findIndex((l) => /create extension if not exists vector/.test(l));
  const firstUse = lines.findIndex((l) => /halfvec\(/.test(l));
  assert.ok(ext >= 0, 'the vector extension must be created in schema.sql');
  assert.ok(firstUse >= 0, 'expected a halfvec column');
  assert.ok(ext < firstUse, `extension on line ${ext + 1}, halfvec used on line ${firstUse + 1}`);
});
