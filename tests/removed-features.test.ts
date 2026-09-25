import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * Resume tailoring and job-matching fingerprints were removed on 25 Sep 2026.
 *
 * Neither was in use. The fingerprints were ~200 MB — 40% of a database at its
 * free-plan ceiling — written by every crawl and read by nothing. Tailoring was
 * the only reader of the stored CV text.
 *
 * These tests stop either from creeping back half-wired, and — the part that
 * matters more — pin down that the features which SHARED code with them kept
 * working: After applying, résumé upload, Best match.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const exists = (p: string) => existsSync(new URL(p, import.meta.url));

function allSource(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(new URL(d, import.meta.url), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('the tailoring and matching code is gone', () => {
  for (const p of ['../src/tailor', '../src/matching', '../app/tailor', '../app/api/tailor']) {
    assert.ok(!exists(p), `${p} is back`);
  }
});

test('nothing imports from the removed folders', () => {
  for (const f of [...allSource('../src'), ...allSource('../app')]) {
    assert.doesNotMatch(read(f), /from ['"][./]*(?:\.\.\/)*src\/(tailor|matching)\/|from ['"]\.\.?\/(tailor|matching)\//, f);
  }
});

test('the crawl no longer fingerprints jobs or holds AI credentials', () => {
  assert.doesNotMatch(read('../src/cli/crawl-db.ts'), /embedNewJobs/);
  assert.doesNotMatch(read('../src/corpus/live.ts'), /digestFor|matchDigest/);
  assert.doesNotMatch(read('../.github/workflows/crawl.yml'), /CLOUDFLARE_(AI_TOKEN|API_TOKEN|ACCOUNT_ID)/);
});

test('the CV text is no longer stored, but Best match still gets its skills', () => {
  const store = read('../src/state/store.ts');
  assert.doesNotMatch(store, /resume_text|getResumeText/);
  // Best match reads these. Removing the text must not have removed them.
  assert.match(store, /skills: extractSkills\(text\)/);
  assert.match(store, /resumeChars: text\.length/);
});

test('the migration drops exactly what was removed, and keeps the resume file', () => {
  const sql = read('../src/db/migrations/2026-09-25-remove-tailor-and-matching.sql')
    .replace(/--.*$/gm, '');
  assert.match(sql, /drop table if exists public\.job_embedding/);
  for (const col of ['resume_embedding', 'resume_model', 'resume_embedded_at', 'resume_version', 'resume_text']) {
    assert.match(sql, new RegExp(`drop column if exists ${col}\\b`), col);
  }
  // The Account page's upload, download and delete depend on these.
  for (const keep of ['skills', 'resume_chars', 'resume_name', 'resume_size', 'resume_path']) {
    assert.doesNotMatch(sql, new RegExp(`drop column if exists ${keep}\\b`), `${keep} must survive`);
  }
});

test('After applying kept both things it borrowed from the tailor folder', () => {
  assert.ok(exists('../src/after-apply/job-lookup.ts'));
  assert.ok(exists('../src/after-apply/rate-limit.ts'));
  assert.match(read('../app/after-apply/page.tsx'), /from '\.\.\/\.\.\/src\/after-apply\/job-lookup\.js'/);
  const route = read('../app/api/after-apply/research/route.ts');
  assert.match(route, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/after-apply\/job-lookup\.js'/);
  assert.match(route, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/after-apply\/rate-limit\.js'/);
});

test('an old /tailor link lands on the feed, not an error page', () => {
  assert.match(read('../next.config.mjs'), /source: '\/tailor', destination: '\/'/);
});
