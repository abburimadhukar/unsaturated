import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Seen/applied marking on Quiet Roles and Institutions.
 *
 * The main feed dims a card once you open its posting and marks it applied; the
 * two secondary pages used the shared JobCard, which had none of that, so opening
 * a role from them left no trace. This adds the same behaviour to the shared card
 * and wires both pages to it. Asserted from the source, the way the other
 * wiring tests are.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const card = read('../app/_components/JobCard.tsx');
const hook = read('../app/_components/useJobState.ts');

test('the shared card dims when seen and marks applied on open', () => {
  // The seen/applied classes the main feed's CSS already styles.
  assert.match(card, /seen \? ' seen' : ''/);
  assert.match(card, /applied \? ' applied' : ''/);
  // An "applied" chip, like the feed's.
  assert.match(card, /className="chip appliedchip"/);
  // Both routes into the posting mark it opened.
  const opens = card.match(/onClick=\{onOpen\}/g) ?? [];
  assert.ok(opens.length >= 2, `expected the title and Open-posting links to mark opened, found ${opens.length}`);
});

test('the mark is optimistic and scoped to the caller', () => {
  // Dims immediately, then tells the server — no waiting on a round trip.
  assert.match(hook, /setSeen\(/);
  assert.match(hook, /setApplied\(/);
  assert.match(hook, /action: 'applied'/);
  // Reads the marks from /api/state, which scopes them to the visitor/session.
  assert.match(hook, /fetch\('\/api\/state'\)/);
});

test('quiet and institutions use the marking and pass it to each card', () => {
  for (const p of ['../app/quiet/page.tsx', '../app/institutions/page.tsx']) {
    const src = read(p);
    assert.match(src, /useJobState\(\)/, `${p} does not use the shared marking`);
    assert.match(src, /seen=\{seen\.has\(j\.key\)\}/, `${p} does not pass seen`);
    assert.match(src, /applied=\{applied\.has\(j\.key\)\}/, `${p} does not pass applied`);
    assert.match(src, /onOpen=\{\(\) => markApplied\(j\.key\)\}/, `${p} does not mark on open`);
  }
});
