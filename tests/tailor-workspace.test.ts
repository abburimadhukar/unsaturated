import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The tailoring workspace, and the measure it is built around.
 *
 * WHAT WENT WRONG, MEASURED RATHER THAN ASSERTED
 *
 * /tailor was capped at 860px and split into two columns, so the resume preview
 * got roughly 350px of text: `860 − 40 padding = 820`, the right column at
 * `1.05fr of 2.05` is 430, less the sheet's own `38 × 2` of padding is 354. At the
 * sheet's font that is about 49 characters a line. A resume on A4 wraps at 95–105.
 *
 * So the preview showed the document at half its real width, and every bullet
 * wrapped twice as often as it does in the file that downloads. That is not a
 * cramped version of the right thing — it makes the preview answer the wrong
 * question. "Would I send this?" cannot be judged from a document at half measure.
 *
 * These tests hold the fix: the DOCUMENT is sized first, and the page is sized
 * around it.
 *
 * Source-reading, like the other component tests: these are client components
 * that fetch on mount, so rendering them would test the network.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const CSS = read('../app/globals.css');
const WORKSPACE = read('../app/_components/TailorWorkspace.tsx');
const PANEL = read('../app/_components/TailorPanel.tsx');
const PARTS = read('../app/_components/tailor-parts.tsx');
const SESSION = read('../app/_components/use-tailor-session.ts');
const PAGE = read('../app/tailor/page.tsx');

// ---------------------------------------------------------------------------
// The measure
// ---------------------------------------------------------------------------

test('THE SHEET HAS A FIXED WIDTH, NOT A SHARE OF WHATEVER IS LEFT', () => {
  // The whole bug. A fraction of the page means the document's measure is decided
  // by the page's width, which is how it ended up at 350px. A fixed width means
  // the page is sized around the document instead.
  const rule = CSS.slice(CSS.indexOf('.twsheet .sheet {'));
  assert.match(rule.slice(0, 200), /width:\s*780px/, 'the sheet is not a fixed width');
  assert.ok(
    !/\.twsheet \.sheet \{[^}]*\bfr\b/.test(CSS),
    'the sheet is sized as a fraction again',
  );
});

test('780px of sheet is about 100 characters, which is what the file will be', () => {
  // 780 − 76 of padding = 704px of text. The sheet is Calibri at 14.5px, whose
  // average advance is close to 0.48em, so 704 / (14.5 × 0.48) ≈ 101 characters.
  // Stated as arithmetic because the number is the point: change the width or the
  // font size without redoing this and the preview quietly goes back to lying.
  const rule = CSS.slice(CSS.indexOf('.twsheet .sheet {'), CSS.indexOf('}', CSS.indexOf('.twsheet .sheet {')));
  const width = Number(/width:\s*(\d+)px/.exec(rule)?.[1]);
  const size = Number(/font-size:\s*([\d.]+)px/.exec(rule)?.[1]);
  const padding = Number(/padding:\s*\d+px\s+(\d+)px/.exec(CSS.slice(CSS.indexOf('.sheet {')))?.[1]);

  assert.ok(width > 0 && size > 0 && padding > 0, 'could not read the measure back');
  const chars = (width - padding * 2) / (size * 0.48);
  assert.ok(chars > 90 && chars < 112, `the measure is ${Math.round(chars)} characters, not ~100`);
});

test('the page does not wrap the workspace in the centred, padded container', () => {
  // .tailorpage is 860px wide. Putting the workspace inside it would reimpose the
  // exact cap this was built to remove, and nothing on screen would say so.
  const at = PAGE.indexOf('<TailorWorkspace');
  assert.ok(at > 0, 'the page no longer renders the workspace');
  const before = PAGE.slice(0, at);
  const lastReturn = before.lastIndexOf('return (');
  assert.ok(
    !before.slice(lastReturn).includes('tailorpage'),
    'the workspace is back inside the 860px page shell',
  );
});

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

test('THE PANES SCROLL, THE PAGE DOES NOT', () => {
  // A resume is two pages long. If the page scrolls, working through the changes
  // scrolls the document off the screen, which is the one thing the arrangement
  // exists to prevent.
  const work = CSS.slice(CSS.indexOf('.twork {'), CSS.indexOf('}', CSS.indexOf('.twork {')));
  assert.match(work, /height:\s*100dvh/);
  assert.match(work, /overflow:\s*hidden/);
  for (const pane of ['.twleft {', '.twright {']) {
    const rule = CSS.slice(CSS.indexOf(pane), CSS.indexOf('}', CSS.indexOf(pane)));
    assert.match(rule, /overflow-y:\s*auto/, `${pane} does not scroll on its own`);
  }
});

test('below the breakpoint the panes become tabs, not a stack', () => {
  // Stacking means scrolling past every suggested change to reach the CV. And the
  // breakpoint has to clear both panes: 440 of changes plus 780 of sheet plus
  // padding and a scrollbar.
  const at = CSS.indexOf('@media (max-width: 1300px)');
  assert.ok(at > 0, 'the tab breakpoint is gone');
  const block = CSS.slice(at, CSS.indexOf('\n}', at));
  assert.match(block, /\.twtabs \{ display: inline-flex/);
  assert.match(block, /\.twork\.pane-changes \.twright \{ display: none/);
  assert.match(block, /\.twork\.pane-resume \.twleft \{ display: none/);

  const cols = CSS.slice(CSS.indexOf('.twbody {'), CSS.indexOf('}', CSS.indexOf('.twbody {')));
  const changes = Number(/grid-template-columns:\s*(\d+)px/.exec(cols)?.[1]);
  const sheet = Number(/width:\s*(\d+)px/.exec(CSS.slice(CSS.indexOf('.twsheet .sheet {')))?.[1]);
  assert.ok(changes + sheet <= 1300, `${changes} + ${sheet} does not fit in the breakpoint`);
});

test('THE POSTING IS A DRAWER, NOT A THIRD COLUMN', () => {
  // Huntr's reviewers describe being dropped into "resume preview, scoring,
  // feedback panels, resume sections, AI tailoring tools, design settings, and
  // various optimizations" at once, and call it overwhelming. Using the whole
  // screen is not the same as filling it. The advert is an input to the work
  // rather than part of it — every change already quotes its own reason.
  assert.match(CSS, /\.twscrim \{[^}]*position: fixed/);
  assert.match(CSS, /\.twdrawer \{/);
  const cols = CSS.slice(CSS.indexOf('.twbody {'), CSS.indexOf('}', CSS.indexOf('.twbody {')));
  assert.equal(
    (cols.match(/minmax|px/g) ?? []).length <= 3,
    true,
    'the body grid has grown a third column',
  );
});

test('the workspace header does not inherit the feed header', () => {
  // The global `header` rule is sticky, 56px tall and backdrop-blurred. This one
  // is a flex row inside a fixed-height shell, so the override has to be by
  // element AND class or the two fight.
  assert.match(CSS, /header\.twtop \{/);
  const rule = CSS.slice(CSS.indexOf('header.twtop {'), CSS.indexOf('}', CSS.indexOf('header.twtop {')));
  assert.match(rule, /position: static/);
  assert.match(rule, /height: auto/);
});

// ---------------------------------------------------------------------------
// The list drives the document
// ---------------------------------------------------------------------------

test('EVERY BLOCK OF THE SHEET CARRIES ITS SOURCE LINE AS AN ID', () => {
  // Without this the changes list is a second list to read alongside the CV
  // rather than navigation into it. Jobscan's one genuinely good idea: click a
  // finding and the document goes there.
  assert.match(PARTS, /const id = `\$\{idPrefix\}-\$\{b\.line\}`/);
  for (const kind of ['sname', 'scontact', 'shead', 'sbullet', 'sbody']) {
    const at = PARTS.indexOf(kind);
    assert.ok(at > 0, `${kind} is gone`);
    assert.ok(
      PARTS.slice(Math.max(0, at - 120), at).includes('id={id}'),
      `${kind} has no id, so the list cannot jump to it`,
    );
  }
});

test('clicking a change scrolls the document to it and flashes it', () => {
  assert.match(WORKSPACE, /function jump\(/);
  assert.match(WORKSPACE, /scrollIntoView/);
  assert.match(WORKSPACE, /setFlash\(line\)/);
  assert.match(CSS, /@keyframes sflash\b/);
});

test('the jump waits a frame, because the pane may have just been switched on', () => {
  // On a narrow screen jump() turns the resume pane on and then scrolls to a line
  // in it. An element that is still display:none cannot be scrolled to, so the
  // scroll would silently do nothing on exactly the screens that need it most.
  const fn = WORKSPACE.slice(WORKSPACE.indexOf('function jump('), WORKSPACE.indexOf('const suggested'));
  assert.match(fn, /setPane\('resume'\)/);
  assert.ok(
    fn.indexOf('requestAnimationFrame') < fn.indexOf('scrollIntoView'),
    'the scroll does not wait for the pane to exist',
  );
});

test('an unaccepted change does not scroll the document somewhere arbitrary', () => {
  // It is not in the CV yet, so there is no line to point at. Selecting the card
  // and leaving the resume where it is beats jumping to a stale match.
  const fn = WORKSPACE.slice(WORKSPACE.indexOf('function jump('), WORKSPACE.indexOf('const suggested'));
  assert.match(fn, /if \(line === null\) return;/);
});

// ---------------------------------------------------------------------------
// The document is there from the start
// ---------------------------------------------------------------------------

test('THE RESUME LOADS BEFORE ANYTHING IS SUGGESTED', () => {
  // The old screen opened on controls with nothing to apply them to, and the CV
  // only existed after clicking through two separate steps. Changes have to land
  // INTO a document that is already on screen.
  assert.match(SESSION, /loadingResume/);
  assert.match(SESSION, /chosenEdits\.length === 0 \? 0 : REBUILD_MS/);
});

test('the document is rebuilt from the ORIGINAL every time, never from the last result', () => {
  // Which is what makes un-accepting possible at all. Splicing onto the previous
  // output would make every acceptance permanent — a sentence cannot be
  // un-spliced once a later edit has overlapped it — and "Skip" after "Use this"
  // would leave the line changed while the list said otherwise.
  const effect = SESSION.slice(SESSION.indexOf('const key = JSON.stringify'), SESSION.indexOf('const run = useCallback'));
  assert.match(effect, /postApply\(chosenEdits\)/);
  assert.ok(
    !/postApply\((built|prev)/.test(effect),
    'the rebuild feeds itself, so a skip cannot put a line back',
  );
});

test('a slow rebuild cannot overwrite a newer one', () => {
  // Clicking through five changes quickly fires five requests. Without this the
  // last response to arrive wins rather than the last request made, and the
  // document ends up showing a selection nobody chose.
  const effect = SESSION.slice(SESSION.indexOf('const key = JSON.stringify'), SESSION.indexOf('const run = useCallback'));
  assert.match(effect, /run !== latest\.current/);
});

test('a failed rebuild keeps the document that is already on screen', () => {
  const effect = SESSION.slice(SESSION.indexOf('const key = JSON.stringify'), SESSION.indexOf('const run = useCallback'));
  const failAt = effect.indexOf('if (!ok) {');
  const block = effect.slice(failAt, effect.indexOf('setNoResume(false)'));
  assert.ok(!block.includes('setBuilt('), 'a failed rebuild blanks the resume');
});

// ---------------------------------------------------------------------------
// The accepted state
// ---------------------------------------------------------------------------

test('A SIGNED-OUT VISITOR DOES NOT GET A BLANK SHEET OF PAPER', () => {
  // The page deliberately has no auth check — it renders a public title and a
  // public company name — so anybody can reach it. Without this branch the right
  // pane renders an EMPTY Sheet, which reads as "we lost your resume" rather than
  // "sign in", and is the worst thing this screen could say.
  const pane = WORKSPACE.slice(WORKSPACE.indexOf('aria-label="Your resume"'));
  assert.match(pane, /\) : !s\.built \? \(/);
  assert.ok(
    pane.indexOf('!s.built ?') < pane.indexOf('<Sheet'),
    'the empty case is checked after the sheet is rendered',
  );
  assert.match(pane, /Sign in/);
});

test('ACCEPTING A CHANGE IS THE LOUD STATE, NOT THE FADED ONE', () => {
  // Both buttons shared `:disabled { opacity: .5 }`, so taking a change faded it
  // and left "Skip" the only solid thing on the card — the unchosen option reading
  // as the chosen one. With seven suggestions and two accepted, nothing on screen
  // answered "which are in?" without counting.
  assert.match(CSS, /\.ttake:disabled:not\(\.done\) \{ opacity: 0\.5; \}/);
  const done = CSS.slice(CSS.indexOf('.ttake.done {'), CSS.indexOf('}', CSS.indexOf('.ttake.done {')));
  assert.ok(!done.includes('opacity'), '.ttake.done is faded again');
  assert.match(done, /background: var\(--hot-dim\)/);
  assert.match(PARTS, /'✓ In your resume'/);
});

test('a rewrite is not shown at the same weight as a word swap', () => {
  // The biggest edit in the list is the one most likely to have thrown away the
  // thing that made the CV worth reading. Rendered identically to a 9% tweak, it
  // gets waved through.
  assert.match(PARTS, /const heavy = pct >= 40;/);
  assert.match(CSS, /\.tedit\.heavy \{/);
  assert.match(CSS, /\.tpct\.heavy \{/);
});

// ---------------------------------------------------------------------------
// One implementation, two screens
// ---------------------------------------------------------------------------

test('BOTH SCREENS SHARE ONE SHEET, ONE DIFF AND ONE CARD', () => {
  // Written twice they drift, and the symptom is the nastiest kind: a change that
  // reads one way in the feed and another on the page it links to, about the same
  // sentence of the same CV.
  for (const [name, src] of [['workspace', WORKSPACE], ['panel', PANEL]] as const) {
    assert.match(src, /from '\.\/tailor-parts\.js'/, `${name} does not use the shared parts`);
    assert.match(src, /useTailorSession/, `${name} does not use the shared session`);
    assert.ok(!/function Sheet\(/.test(src), `${name} has its own copy of Sheet`);
    assert.ok(!/function Diff\(/.test(src), `${name} has its own copy of Diff`);
  }
});

test('the feed panel stays one column', () => {
  // A feed card is around 700px. Two columns there gave the document 300, and a
  // CV at 300px is unreadable. The arrangement is only an improvement when there
  // is room for it — which is what the full page is for.
  assert.ok(!PANEL.includes('tcols'), 'the panel is side-by-side again');
  assert.match(PANEL, /open the full editor/);
});

test('THE OLD TWO-COLUMN SHELL IS GONE FROM THE STYLESHEET, NOT JUST UNUSED', () => {
  // Left in place it is an invitation: the next screen gets built on it because it
  // is there, and the 350px document comes back.
  for (const dead of ['.tcols', '.tleft', '.tright', '.tawait']) {
    assert.ok(!CSS.includes(dead), `${dead} is still in globals.css`);
    for (const [name, src] of [['workspace', WORKSPACE], ['panel', PANEL]] as const) {
      assert.ok(!src.includes(dead.slice(1)), `${name} still uses ${dead}`);
    }
  }
});

test('the drawer dims and shadows through tokens, like everything else', () => {
  // A literal here would be wrong in one theme, which is the hardest kind of
  // styling mistake to notice. Both are defined in both blocks.
  for (const token of ['--scrim', '--shadow']) {
    assert.equal(
      (CSS.match(new RegExp(`${token}:`, 'g')) ?? []).length,
      2,
      `${token} is not defined in both themes`,
    );
  }
});
