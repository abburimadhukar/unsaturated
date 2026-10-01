import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { safeBackTo } from '../src/ui/back-link.js';

/**
 * The "After applying" back button now carries the reader's filters, so the
 * value it is built from goes into an anchor's href. These tests pin the thing
 * that matters: a crafted `from` can never become an off-site or script link, and
 * a genuine same-site view (filters and all) is preserved.
 */

test('a same-site list path, with its filters, is kept intact', () => {
  for (const [from, label] of [
    ['/', 'jobs'],
    ['/quiet', 'quiet roles'],
    ['/institutions', 'institutions'],
    ['/?family=cloud&country=GB', 'jobs'],
    ['/quiet?family=data&seniority=senior', 'quiet roles'],
    ['/institutions?sector=health&specialization=backend', 'institutions'],
  ] as const) {
    const back = safeBackTo(from);
    assert.equal(back.href, from, `${from} should be preserved exactly`);
    assert.equal(back.label, label);
  }
});

test('anything that is not a bare same-site path falls back to the feed', () => {
  const hostile = [
    undefined,
    null,
    '',
    'https://evil.example.com', // absolute, off-site
    '//evil.example.com', // protocol-relative
    'javascript:alert(1)', // script URI
    '/\\evil.example.com', // backslash the browser may treat as a slash
    '\\/evil.example.com',
    'quiet', // no leading slash
    '/admin', // a real path, but not one of the list pages
    '/api/feed', // not a list page
    '/' + 'x'.repeat(400), // absurdly long
  ];
  for (const from of hostile) {
    const back = safeBackTo(from as string | undefined);
    assert.equal(back.href, '/', `${String(from)} must fall back to /`);
    assert.equal(back.label, 'jobs');
  }
});

test('the pathname decides the label, not the query', () => {
  // A query that mentions another page must not change where "back" points.
  const back = safeBackTo('/quiet?from=/institutions&q=/');
  assert.equal(back.href, '/quiet?from=/institutions&q=/');
  assert.equal(back.label, 'quiet roles');
});

// --- the pages are actually wired to carry and restore (source checks) --------

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('after-apply validates the back target rather than trusting it', () => {
  const src = read('../app/after-apply/page.tsx');
  assert.match(src, /safeBackTo\(from\)/);
  // The old unchecked fixed map is gone.
  assert.doesNotMatch(src, /const BACK_TO/);
});

test('every list page carries its filters into the After applying link', () => {
  // The main feed builds a from with its query; quiet and institutions pass a
  // backTo that includes their filters rather than a bare path.
  assert.match(read('../app/page.tsx'), /from=\$\{encodeURIComponent\(backTo\)\}/);
  assert.match(read('../app/quiet/page.tsx'), /`\/quiet\?\$\{qs\}`/);
  assert.match(read('../app/institutions/page.tsx'), /`\/institutions\?\$\{qs\}`/);
});

test('quiet and institutions remember and restore their place', () => {
  for (const p of ['../app/quiet/page.tsx', '../app/institutions/page.tsx']) {
    const src = read(p);
    assert.match(src, /initialShown\(SCROLL_KEY, PAGE\)/, `${p} should start at the saved page count`);
    assert.match(src, /savedScrollY\(SCROLL_KEY\)/, `${p} should restore the saved scroll`);
    assert.match(src, /writeRestorable\(SCROLL_KEY/, `${p} should save its place`);
    assert.match(src, /addEventListener\('pagehide'/, `${p} should save on leaving`);
  }
});
