import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { initialsOf } from '../src/ui/initials.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const css = read('../app/globals.css');

// ---------------------------------------------------------------------------
// Initials
// ---------------------------------------------------------------------------

test('two letters from a name', () => {
  assert.equal(initialsOf('Ada', 'Lovelace', 'ada@example.com'), 'AL');
  assert.equal(initialsOf('madhukar', 'abburi', 'x@y.com'), 'MA');
});

test('a half-filled name still yields something', () => {
  assert.equal(initialsOf('Ada', null, 'ada@example.com'), 'A');
  assert.equal(initialsOf(null, 'Lovelace', 'ada@example.com'), 'L');
  assert.equal(initialsOf(' ', ' ', 'ada@example.com'), 'A');
});

test('no name falls back to ONE letter of the email, never two', () => {
  // "ab" from abburimadhukar@… reads as initials and is not: it is the start of
  // a username, and showing it would make an unnamed account look named.
  assert.equal(initialsOf(null, null, 'abburimadhukar@gmail.com'), 'A');
  assert.equal(initialsOf(null, null, 'zoe@example.com').length, 1);
});

test('an empty email cannot crash the header', () => {
  assert.equal(initialsOf(null, null, ''), '?');
});

// ---------------------------------------------------------------------------
// Both themes still complete, with the family colours added
// ---------------------------------------------------------------------------

test('every family colour is defined in both themes', () => {
  const block = (sel: string) => {
    const at = css.indexOf(sel);
    assert.notEqual(at, -1, `${sel} missing`);
    return css.slice(at, css.indexOf('}', at));
  };
  const dark = block(':root {');
  const light = block(":root[data-theme='light']");
  for (const family of ['cloud', 'software', 'data', 'hris', 'unsorted']) {
    for (const suffix of ['', '-dim']) {
      const token = `--fam-${family}${suffix}`;
      assert.ok(dark.includes(token), `dark theme missing ${token}`);
      assert.ok(light.includes(token), `light theme missing ${token}`);
    }
  }
});

test('no family colour collides with a colour that means something else', () => {
  // Green means uncontested, red means ghost risk, violet means AI, amber means
  // adjacent. A family colour says what KIND of work a job is and must never be
  // mistaken for a verdict on it.
  const hexes = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]),
    ) as Record<string, string>;
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const gap = (a: string, b: string) => {
    const [x, y, z] = rgb(a);
    const [p, q, r] = rgb(b);
    return Math.hypot(x - p, y - q, z - r);
  };
  const meaningful = ['--hot', '--danger', '--ai', '--adjacent', '--accent'];
  // Both themes. The light palette is where this exact mistake was made before.
  for (const sel of [':root {', ":root[data-theme='light']"]) {
    const at = css.indexOf(sel);
    const palette = hexes(css.slice(at, css.indexOf('}', at)));
    for (const family of ['cloud', 'software', 'data', 'hris']) {
      const mine = palette[`--fam-${family}`];
      assert.ok(mine, `${sel}: --fam-${family} missing`);
      for (const other of meaningful) {
        const theirs = palette[other];
        if (!theirs) continue;
        assert.ok(gap(mine, theirs) > 55,
          `${sel} --fam-${family} ${mine} is only ${gap(mine, theirs).toFixed(0)} from ${other} ${theirs}`);
      }
    }
  }
});

test('the families are distinguishable from each other', () => {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const names = ['cloud', 'software', 'data', 'hris'];
  // Both themes: a set of colours that separates cleanly on black can converge
  // on white, since darkening every hue pushes them all toward each other.
  for (const sel of [':root {', ":root[data-theme='light']"]) {
    const at = css.indexOf(sel);
    const block = css.slice(at, css.indexOf('}', at));
    const get = (n: string) => block.match(new RegExp(`${n}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = get(`--fam-${names[i]}`);
        const b = get(`--fam-${names[j]}`);
        assert.ok(a && b, `${sel}: missing ${names[i]} or ${names[j]}`);
        const [x, y, z] = rgb(a);
        const [p, q, r] = rgb(b);
        const d = Math.hypot(x - p, y - q, z - r);
        assert.ok(d > 60, `${sel} ${names[i]} and ${names[j]} are only ${d.toFixed(0)} apart`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The page and the form
// ---------------------------------------------------------------------------

test('the account page carries everything that left the header', () => {
  const page = read('../app/account/page.tsx');
  for (const [what, needle] of [
    ['theme switch', 'unsaturated.theme'],
    ['resume', '/api/profile'],
    ['name editing', '/api/profile/name'],
    ['applied count', 'applied'],
    ['seen count', 'jobs opened'],
    ['sign out', '/api/auth/signout'],
  ] as [string, string][]) {
    assert.ok(page.includes(needle), `account page is missing ${what}`);
  }
});

test('the applied count stays in the header, as decided', () => {
  const page = read('../app/page.tsx');
  assert.match(page, /onlyApplied/, 'the applied filter left the header');
  assert.match(page, /className="avatar"/, 'the avatar is not in the header');
  // The controls that moved must be gone, not merely hidden.
  assert.ok(!page.includes('Switch to light theme'), 'the theme toggle is still in the header');
});

test('sign-in requires a first and last name', () => {
  const form = read('../app/signin/page.tsx');
  assert.match(form, /given-name/);
  assert.match(form, /family-name/);
  assert.match(form, /!first\.trim\(\) \|\| !last\.trim\(\)/, 'the button is not gated on the name');
  const api = read('../app/api/auth/signin/route.ts');
  assert.match(api, /enter your first and last name/, 'the API accepts a nameless sign-in');
  // Carried into the new account's metadata, so a new user arrives named.
  assert.match(api, /data: \{ first_name/);
});

test('the sign-in form asks everyone, so it cannot reveal who has an account', () => {
  // A form that skipped the name for returning users would behave differently
  // for them, and that difference is a way to discover which addresses hold
  // accounts — the leak the identical seat-full message exists to avoid.
  const form = read('../app/signin/page.tsx');
  assert.ok(!/hasAccount|existingUser|isReturning/.test(form),
    'the form branches on whether the account exists');
});
