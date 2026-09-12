import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Three pages, one interface.
 *
 * Quiet Roles and Institutions drifted into a different layout from the main feed:
 * 900px single columns with their controls as a row of pill buttons, against the
 * feed's 1240px sidebar. Same product, three arrangements, and the difference was
 * doing no work — a visitor who learned the feed had to learn the others.
 *
 * The JobCard already existed for exactly this reason, and its own header says so:
 * "they were drifting into a different card the moment the second one existed."
 * The card stopped drifting and the page around it did not. These tests are the
 * rest of that fix.
 *
 * Source-reading, like the other page tests: these pages are client components
 * that fetch on mount, so rendering them would test the network.
 */

const page = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const FEED = '../app/page.tsx';
const LIST_PAGES = ['../app/quiet/page.tsx', '../app/institutions/page.tsx'];
const ALL = [FEED, ...LIST_PAGES];

test('ALL THREE PAGES USE THE SAME TWO-COLUMN LAYOUT', () => {
  for (const p of ALL) {
    assert.match(page(p), /<div className="layout">/, `${p} is not on the shared layout`);
  }
});

test('all three put their controls in the same sidebar', () => {
  for (const p of ALL) {
    assert.match(page(p), /className=\{`sidebar\$\{filtersOpen \? '' : ' collapsed'\}`\}/, p);
  }
});

test('ALL THREE COLLAPSE THAT SIDEBAR ON A PHONE', () => {
  // Without the toggle a visitor scrolls past the entire control panel before
  // reaching a single job. The feed had this; the other two did not, which made
  // them markedly worse on the device most people open a link on.
  for (const p of ALL) {
    assert.match(page(p), /className="filtertoggle"/, `${p} has no filter toggle`);
    assert.match(page(p), /aria-expanded=\{filtersOpen\}/, `${p} does not announce its state`);
  }
});

test('the primary navigation sits above the layout on every page', () => {
  // Families on the feed, families on Quiet, sectors on Institutions — the same bar
  // in the same place. Putting it inside the content column on two of three pages
  // is what made them feel unrelated.
  for (const p of ALL) {
    const src = page(p);
    const navAt = src.indexOf('<nav className="families"');
    const mainAt = src.indexOf('<main');
    assert.ok(navAt > 0, `${p} has no families nav`);
    assert.ok(navAt < mainAt, `${p} puts its navigation inside main`);
  }
});

test('THE OLD SINGLE-COLUMN SHELL IS GONE, NOT JUST UNUSED', () => {
  // Left in the stylesheet it is an invitation: the next page gets built on it
  // because it is there, and the drift starts again. Removed from both the markup
  // and the CSS.
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  for (const dead of ['listpage', 'quietintro', 'quietnarrow', 'quietfams']) {
    assert.ok(!css.includes(dead), `.${dead} is still in globals.css`);
    for (const p of ALL) {
      assert.ok(!page(p).includes(dead), `${p} still uses ${dead}`);
    }
  }
});

test('the two list pages still render through the shared JobCard', () => {
  // The card was extracted because the pages were drifting apart. Aligning the
  // shell must not have quietly inlined a second copy of the card.
  for (const p of LIST_PAGES) {
    assert.match(page(p), /<JobCard/, `${p} no longer uses the shared card`);
  }
});

test('each page keeps its own reason for existing, in its own panel', () => {
  // Aligning the layout is not flattening the content. The paragraph explaining
  // what the page is has to survive the move — it is the only thing that tells a
  // visitor why Quiet Roles is not just the feed with fewer jobs.
  assert.match(page('../app/quiet/page.tsx'), /Quiet roles/);
  assert.match(page('../app/quiet/page.tsx'), /title people do not search for/);
  assert.match(page('../app/institutions/page.tsx'), /Institutions/);
  assert.match(page('../app/institutions/page.tsx'), /Universities, hospitals/);
});

test('the page accent still differs, because the pages still differ', () => {
  // page-quiet and page-inst set --accent on the wrapper and every rule inherits
  // it. Same layout, different colour: that is the intended relationship, and
  // losing it would make the three pages genuinely indistinguishable.
  assert.match(page('../app/quiet/page.tsx'), /className="page-quiet"/);
  assert.match(page('../app/institutions/page.tsx'), /className="page-inst"/);
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.page-quiet/);
  assert.match(css, /\.page-inst/);
});

test('THE LOAD-MORE CONTROL IS THE SAME SHAPE EVERYWHERE', () => {
  // The feed wraps it in a div; the list pages had a bare button with the same
  // class, so it picked up the container's styling and sat flush left while the
  // feed's was centred.
  for (const p of ALL) {
    assert.match(page(p), /<div className="more">/, `${p} does not wrap its load-more`);
  }
});
