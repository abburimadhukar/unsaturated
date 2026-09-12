import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Keeping the CV text, without publishing it.
 *
 * Storing a resume reverses a rule this project held from the start — no CV text
 * in the database — and the rule was right for as long as `user_state` was
 * readable with the publishable key. On 11 September 2026 one unauthenticated
 * request returned all seven rows: three real names, their extracted skills, and
 * the storage path to each file. Had the text been in that table, the text would
 * have been public.
 *
 * That policy is gone, which is the only reason this column is defensible. These
 * tests hold the two things that make it stay defensible: the migration refuses to
 * run if anon can read the table, and the text never becomes part of what the
 * browser is sent.
 *
 * Source-reading rather than executing, because dbWrite() builds a real client
 * from the environment and is not injectable — the same approach the existing
 * schema-drift test takes.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const store = () => read('../src/state/store.ts');
const migration = () => read('../src/db/migrations/2026-09-12-resume-text.sql');

// ---------------------------------------------------------------------------
// The column exists everywhere it has to
// ---------------------------------------------------------------------------

test('SCHEMA.SQL DECLARES resume_text', () => {
  // The existing drift test derives its column list from UserStateRow, and
  // resume_text is deliberately not on that interface — it is written by its own
  // UPDATE. So it needs its own guard, or a fresh database comes up without it
  // and tailoring silently finds no resume for anybody.
  const schema = read('../src/db/schema.sql');
  const block = schema.slice(schema.indexOf('create table if not exists public.user_state'));
  const declared = block.slice(0, block.indexOf(');'));
  assert.ok(declared.includes('resume_text'), 'a fresh database would have no resume_text column');
});

test('the migration adds it without destroying an existing one', () => {
  assert.match(migration(), /add column if not exists resume_text/);
  // Re-running a migration is routine here; this one must not be the exception.
  assert.doesNotMatch(migration(), /drop column/i);
});

// ---------------------------------------------------------------------------
// The guard that makes the column defensible
// ---------------------------------------------------------------------------

test('THE MIGRATION REFUSES TO RUN IF ANON CAN READ user_state', () => {
  // The whole argument for storing CV text is that this table is closed. A future
  // migration re-adding a permissive select policy would turn every resume into
  // public text with no error anywhere, so the check has to fail loudly at that
  // moment rather than trust that nobody will.
  const sql = migration();
  assert.match(sql, /pg_policies/, 'it must actually inspect the policies');
  assert.match(sql, /'anon' = any \(roles\)/);
  assert.match(sql, /cmd = 'SELECT'/);
  assert.match(sql, /raise exception/);
  assert.match(sql, /refusing to store CV text/i);
});

test('THE MIGRATION ALSO CHECKS RLS IS SWITCHED ON', () => {
  // Having no policies means nothing if row-level security is disabled — the
  // table is then readable regardless, and the policy check above would pass
  // while every CV stayed exposed. Two different failures, so two checks.
  const sql = migration();
  assert.match(sql, /relrowsecurity/);
  assert.match(sql, /row-level security is off/i);
});

test('the migration says why the old rule is being reversed', () => {
  // Not decoration. The next person to read this has to know that "no CV text in
  // the database" was dropped on purpose and on what condition, or they will
  // either restore the rule or quietly break its premise.
  const sql = migration();
  assert.match(sql, /2026-09-11-private-profiles\.sql/, 'it must name what closed the hole');
  assert.match(sql, /no backfill/i, 'and be explicit that existing text is unrecoverable');
});

// ---------------------------------------------------------------------------
// It must not reach the browser
// ---------------------------------------------------------------------------

test('THE CV TEXT IS NOT PART OF THE PROFILE THE BROWSER RECEIVES', () => {
  // Profile is returned by /api/me, /api/profile, /api/profile/name and
  // /api/profile/resume-file. On the type, the CV would be sent down the wire on
  // every page load and a leak would be one forgotten line away in any of them.
  // Off the type, no route can return it, because no route has it.
  const src = store();
  const iface = src.slice(
    src.indexOf('export interface Profile {'),
    src.indexOf('}', src.indexOf('export interface Profile {')),
  );
  assert.ok(iface.length > 50, 'the Profile interface was not found');
  assert.ok(!iface.includes('resumeText'), 'the CV text is on Profile and will reach the browser');
  assert.ok(!iface.includes('resume_text'), 'the CV text is on Profile and will reach the browser');
});

test('the profile read does not select the CV text', () => {
  // load() populates Profile, which is serialised to the client. Adding
  // resume_text to that select list is the other way the text escapes.
  const src = store();
  const selects = [...src.matchAll(/select\('([^']*)'\)/g)].map((m) => m[1]!);
  const profileSelect = selects.find((s) => s.includes('resume_chars'));
  assert.ok(profileSelect, 'the profile select was not found');
  assert.ok(
    !profileSelect.includes('resume_text'),
    'the profile read pulls the CV text into a client-bound object',
  );
});

test('EMPTY_PROFILE carries no CV text either', () => {
  const src = store();
  const empty = src.slice(src.indexOf('export const EMPTY_PROFILE'), src.indexOf('};', src.indexOf('export const EMPTY_PROFILE')));
  assert.ok(!empty.includes('resumeText'));
});

test('no API route mentions the CV text at all', () => {
  // A belt to the braces above: the only code that may touch this column lives in
  // store.ts behind getResumeText. A route reading it directly would bypass that.
  for (const route of [
    '../app/api/profile/route.ts',
    '../app/api/me/route.ts',
    '../app/api/profile/name/route.ts',
    '../app/api/admin/route.ts',
  ]) {
    assert.ok(
      !read(route).includes('resume_text'),
      `${route} reads resume_text directly instead of going through getResumeText`,
    );
  }
});

// ---------------------------------------------------------------------------
// How it is written
// ---------------------------------------------------------------------------

test('THE TEXT IS WRITTEN BY AN UPDATE NAMING ONE COLUMN, NOT AN UPSERT', () => {
  // This is the reason it is a separate function rather than a field on the row
  // persistProfile upserts. An UPDATE that does not mention a column cannot touch
  // it, so setProfileName, setResumeFile and clearResumeFile cannot wipe the CV,
  // and this cannot wipe them. No assumption about how an upsert treats an absent
  // column is involved — and that assumption is exactly what broke updated_at for
  // every new account once already.
  const src = store();
  const fn = src.slice(
    src.indexOf('async function writeResumeText'),
    src.indexOf('export async function setProfileFromResume'),
  );
  assert.ok(fn.length > 100, 'writeResumeText was not found');
  assert.match(fn, /\.update\(\{ resume_text: text \}\)/);
  assert.ok(!fn.includes('.upsert('), 'an upsert here could clobber the other columns');
  assert.match(fn, /\.eq\('user_id', userId\)/, 'it must be scoped to one person');
});

test('A FAILED TEXT WRITE IS NOT REPORTED AS SUCCESS', () => {
  // supabase-js returns database errors rather than throwing them, and this
  // project has already shipped an endpoint that answered 200 for a resume it
  // never stored. Somebody waiting to hear whether their CV saved must not be
  // told yes.
  const src = store();
  const fn = src.slice(src.indexOf('async function writeResumeText'), src.indexOf('export async function setProfileFromResume'));
  assert.match(fn, /if \(error\)/);
  assert.match(fn, /throw new Error/);
});

test('THE TEXT IS WRITTEN AFTER THE PROFILE, BECAUSE THE ROW MAY NOT EXIST YET', () => {
  // persistProfile upserts and is therefore what creates the row for somebody
  // saving a CV before they have any other state. An UPDATE against a row that
  // does not exist yet affects nothing and reports no error, so reversing this
  // order would lose the text of every first-ever resume — silently, and only for
  // new accounts, which is the hardest kind of bug to notice.
  const src = store();
  const fn = src.slice(
    src.indexOf('export async function setProfileFromResume'),
    src.indexOf('export async function setProfileSkills'),
  );
  const persistAt = fn.indexOf('persistProfile(');
  const writeAt = fn.indexOf('writeResumeText(');
  assert.ok(persistAt >= 0, 'persistProfile is not called');
  assert.ok(writeAt >= 0, 'writeResumeText is not called — the CV is still being discarded');
  assert.ok(persistAt < writeAt, 'the text is written before the row is created');
});

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

test('getResumeText exists, is scoped to one person, and never throws', () => {
  // Its three failure cases — no row, no text, no database — all mean the same
  // thing to the caller, which is to tell the person to add their resume. Throwing
  // would turn that into a 500 instead of a sentence.
  const src = store();
  const fn = src.slice(src.indexOf('export async function getResumeText'), src.indexOf('async function writeResumeText'));
  assert.ok(fn.length > 100, 'getResumeText was not found');
  assert.match(fn, /\.eq\('user_id', userId\)/, 'it must not read somebody else resume');
  assert.match(fn, /try \{/);
  assert.match(fn, /catch/);
  assert.ok(fn.includes("return ''"), 'it must fall back to empty rather than throwing');
});

test('the CV text is read fresh rather than from the profile cache', () => {
  // A five-second cache on a CV means tailoring a resume the person has just
  // edited, and the whole point of the feature is that the diff reflects what they
  // actually wrote.
  const src = store();
  const fn = src.slice(src.indexOf('export async function getResumeText'), src.indexOf('async function writeResumeText'));
  assert.ok(!fn.includes('load('), 'it goes through the cached profile read');
  assert.ok(!fn.includes('slots()'), 'it goes through the profile cache');
});
