import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FILTER_DEFAULTS,
  parseFilters,
  serializeFilters,
  applyFilterChange,
} from '../src/ui/filter-state.js';

/**
 * Two things that are easy to get subtly wrong and hard to notice.
 *
 * A colour hard-coded in one rule looks fine in the theme it was written for
 * and unreadable in the other, and nobody finds it for a week. And a
 * visitor-specific filter that reaches the API would make every response unique
 * — quietly undoing the CDN caching the whole feed was rebuilt around.
 */

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

test('both themes define every colour token', () => {
  const block = (selector: string) => {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, `${selector} block missing`);
    return css.slice(at, css.indexOf('}', at));
  };
  const names = (s: string) => new Set([...s.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  const dark = names(block(':root {'));
  const light = names(block(":root[data-theme='light']"));

  // --radius* are shape, not colour, and are inherited from the dark block.
  const colours = [...dark].filter((n) => !n.startsWith('--radius'));
  const missing = colours.filter((n) => !light.has(n));
  assert.deepEqual(missing, [], `light theme is missing: ${missing.join(', ')}`);
});

test('no colour is hard-coded outside the token blocks', () => {
  // Everything after the light block is rules. A literal colour there applies
  // to both themes and will be wrong in one of them.
  // From the END of the light block. Anchoring on a declaration inside it
  // swallowed that declaration's own value and reported it as a violation.
  const lightAt = css.indexOf(":root[data-theme='light']");
  const rules = css.slice(css.indexOf('}', lightAt) + 1);
  const literals = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], `hard-coded colours: ${literals.join(', ')}`);
});

test('the accent and the danger colour are not near-neighbours', () => {
  // They were #e08a63 and #f2705c — an "apply" link and a "this may be a ghost
  // posting" warning one shade apart.
  const hex = (name: string, from: string) => {
    const at = css.indexOf(from);
    const m = css.slice(at).match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
    return m ? m[1] : null;
  };
  for (const block of [':root {', ":root[data-theme='light']"]) {
    const a = hex('--accent', block);
    const d = hex('--danger', block);
    assert.ok(a && d, `missing accent or danger in ${block}`);
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [ar, ag, ab] = rgb(a);
    const [dr, dg, db] = rgb(d);
    const distance = Math.hypot(ar - dr, ag - dg, ab - db);
    assert.ok(distance > 60, `${block}: accent ${a} and danger ${d} are only ${distance.toFixed(0)} apart`);
  }
});

test('the flash guard runs before the body, and cannot throw', () => {
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /localStorage\.getItem\('unsaturated\.theme'\)/);
  // Reading localStorage throws outright in private browsing. A theme
  // preference must never be able to stop the page rendering.
  assert.match(layout, /catch\s*\(e\)\s*\{\}/);
  assert.ok(
    layout.indexOf('THEME_SCRIPT') < layout.indexOf('<body>'),
    'the script must run before the body paints',
  );
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

test('onlyApplied exists and defaults to off', () => {
  assert.equal(FILTER_DEFAULTS.onlyApplied, false);
});

test('onlyApplied survives a URL round trip', () => {
  const on = applyFilterChange(FILTER_DEFAULTS, 'onlyApplied', true);
  const qs = serializeFilters(on);
  assert.match(qs, /onlyApplied=1/);
  assert.equal(parseFilters(`?${qs}`).onlyApplied, true);
});

test('a default filter set keeps a clean URL', () => {
  assert.equal(serializeFilters(FILTER_DEFAULTS), '');
});

test('visitor-specific filters never reach the API', () => {
  // hideSeen, minFit and onlyApplied all depend on who is asking. Sending any
  // of them would split the CDN cache into an entry per visitor, which is the
  // thing the public feed was rebuilt to avoid — and the API rejects them.
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const guard = page.match(/if \(k === 'hideSeen'[^\n]*\) continue;/);
  assert.ok(guard, 'the request builder no longer skips visitor-side filters');
  for (const key of ['hideSeen', 'minFit', 'onlyApplied']) {
    assert.match(guard[0], new RegExp(`'${key}'`), `${key} would be sent to the API`);
  }
});
