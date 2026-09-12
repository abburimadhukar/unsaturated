import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_ANNUAL_USD,
  MIN_ANNUAL_USD,
  isPlausibleAnnual,
  knownCurrencies,
  toUsd,
} from '../src/ats/currency.js';

/**
 * Comparing pay across currencies.
 *
 * THE BUG, measured on the live corpus 12 September 2026
 *
 * "Highest paid" ordered on the raw number with no regard to currency. One
 * employer, Weekdayworks, publishes 19 postings in RUPEES — ₹500,000 to
 * ₹10,000,000, an ordinary Indian range of roughly $6k to $120k. ₹10,000,000
 * beats every real dollar salary, so those 19 owned the entire first page of
 * highest-paid, apparently offering $10 million for a frontend engineer.
 *
 * 22 INR postings in total, plus PLN, SEK, DKK, MXN, CZK and CHF all competing
 * against dollars on magnitude alone.
 *
 * AND THE SECOND BUG
 *
 * The structured-salary check had a floor and no ceiling, so "Gage PBL Test Job"
 * stored $27,924,000 and a policy fellowship stored $15,600,000. A ceiling has
 * to be currency-aware or it throws away every real rupee salary — which is how
 * a fix becomes a worse bug, and is the case most of these tests guard.
 */

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

test('dollars are unchanged', () => {
  assert.equal(toUsd(150_000, 'USD'), 150_000);
});

test('RUPEES ARE NOT DOLLARS', () => {
  // The number at the heart of it: ₹10,000,000 is about $119k, not $10m.
  const usd = toUsd(10_000_000, 'INR');
  assert.ok(usd > 100_000 && usd < 140_000, `₹10,000,000 came out as $${Math.round(usd)}`);
});

test('a missing currency is read as dollars, not dropped', () => {
  // The feed's median posting is American, and the ceiling catches anything this
  // assumption gets badly wrong. 37 open jobs have a salary and no currency.
  assert.equal(toUsd(150_000, null), 150_000);
  assert.equal(toUsd(150_000, undefined), 150_000);
});

test('an unknown code is read as dollars rather than mangled', () => {
  assert.equal(toUsd(150_000, 'XYZ'), 150_000);
  assert.equal(toUsd(150_000, ''), 150_000);
});

test('the code is read case-insensitively and trimmed', () => {
  assert.equal(toUsd(84_000, 'inr'), toUsd(84_000, 'INR'));
  assert.equal(toUsd(84_000, ' INR '), toUsd(84_000, 'INR'));
});

test('nonsense in gives zero out rather than NaN', () => {
  assert.equal(toUsd(Number.NaN, 'USD'), 0);
  assert.equal(toUsd(Number.POSITIVE_INFINITY, 'USD'), 0);
});

test('every rate is positive and finite, so none can produce a division surprise', () => {
  const rates = knownCurrencies();
  assert.ok(rates.length > 20, `expected a real table, got ${rates.length}`);
  for (const { code, perUsd } of rates) {
    assert.ok(Number.isFinite(perUsd) && perUsd > 0, `${code} has rate ${perUsd}`);
    assert.match(code, /^[A-Z]{3}$/, `${code} is not a currency code`);
  }
  assert.equal(rates.find((r) => r.code === 'USD')?.perUsd, 1, 'USD must be the unit');
});

// ---------------------------------------------------------------------------
// Plausibility — the real values that broke it
// ---------------------------------------------------------------------------

test('THE TEST POSTING AND THE FELLOWSHIP ARE REJECTED', () => {
  // Verbatim from the live corpus. Both sat at the top of "highest paid".
  assert.equal(isPlausibleAnnual(27_924_000, 'USD'), false, 'Gage PBL Test Job @ Reteam');
  assert.equal(isPlausibleAnnual(15_600_000, 'USD'), false, 'Policy Fellow @ Standtogether');
});

test('A REAL RUPEE SALARY IS KEPT, WHICH A FLAT CEILING WOULD HAVE DESTROYED', () => {
  // The whole reason the ceiling is currency-aware. ₹10,000,000 is ~$119k and a
  // perfectly ordinary senior Indian salary; a flat $2m ceiling keeps it, but a
  // flat ceiling low enough to reject $27.9m as absurd would not.
  assert.equal(isPlausibleAnnual(10_000_000, 'INR'), true);
  // And the same number in dollars is not plausible at all.
  assert.equal(isPlausibleAnnual(10_000_000, 'USD'), false);
});

test('real salaries from the live corpus survive', () => {
  const real: [number, string | null, string][] = [
    [445_000, 'USD', 'Engineering Manager @ OpenAI'],
    [149_000, 'USD', 'SDET @ PathAI'],
    [250_000, 'USD', 'Forward Deployed Engineer @ Retell'],
    [539_808, 'GBP', 'highest GBP on the corpus'],
    [670_000, 'SEK', 'highest SEK'],
    [1_158_000, 'MXN', 'highest MXN'],
    [334_300, 'CAD', 'highest CAD'],
    [230_400, 'EUR', 'highest EUR'],
  ];
  for (const [amount, currency, what] of real) {
    assert.equal(isPlausibleAnnual(amount, currency), true, `${what} was rejected`);
  }
});

test('an hourly rate is not an annual salary', () => {
  // The original bug this check existed for: a role showing "$120 to $134" a year.
  assert.equal(isPlausibleAnnual(120, 'USD'), false);
  assert.equal(isPlausibleAnnual(25, 'USD'), false);
});

test('zero and negatives are never a salary', () => {
  for (const bad of [0, -1, -100_000]) {
    assert.equal(isPlausibleAnnual(bad, 'USD'), false, String(bad));
  }
  assert.equal(isPlausibleAnnual(Number.NaN, 'USD'), false);
});

test('the bounds are the documented ones, in dollars', () => {
  assert.equal(MIN_ANNUAL_USD, 15_000);
  assert.equal(MAX_ANNUAL_USD, 2_000_000);
  // Inclusive at both ends, so a figure exactly on the line is kept rather than
  // silently lost to a strict comparison.
  assert.equal(isPlausibleAnnual(MIN_ANNUAL_USD, 'USD'), true);
  assert.equal(isPlausibleAnnual(MAX_ANNUAL_USD, 'USD'), true);
  assert.equal(isPlausibleAnnual(MIN_ANNUAL_USD - 1, 'USD'), false);
  assert.equal(isPlausibleAnnual(MAX_ANNUAL_USD + 1, 'USD'), false);
});

test('a KNOWN LIMITATION is recorded: the floor is in dollars', () => {
  // ₹500,000 is ~$5,950 — a real entry-level Indian salary, and it is dropped,
  // because the floor exists to catch hourly and monthly figures written into an
  // annual column and there is no way to tell those from a genuinely low annual
  // wage by magnitude alone.
  //
  // Measured cost on the live corpus: 2 postings of 13,972 with a salary. The
  // project's rule is that a wrong number is worse than none, so dropping is the
  // right side to err on — but it is a real loss and not an accident.
  assert.equal(isPlausibleAnnual(500_000, 'INR'), false);
});

// ---------------------------------------------------------------------------
// The SQL has to agree with the TypeScript
// ---------------------------------------------------------------------------

test('THE MIGRATION AND THE CODE USE THE SAME RATES', () => {
  // Two copies of a rate table is two chances to be inconsistent, and the symptom
  // would be a sort that disagrees with the plausibility check — a job kept by one
  // and ranked by the other as if it were a different amount.
  const sql = readFileSync(
    new URL('../src/db/migrations/2026-09-12-salary-usd.sql', import.meta.url),
    'utf8',
  );
  for (const { code, perUsd } of knownCurrencies()) {
    if (code === 'USD') continue;
    const pattern = new RegExp(`when '${code}' then ${String(perUsd).replace('.', '\\.')}`, 'i');
    assert.match(sql, pattern, `${code} at ${perUsd} is missing from the migration`);
  }
});

test('the migration refuses to guess if the function it patches has changed', () => {
  // It rewrites feed_page by patching the live definition rather than retyping
  // ~100 lines. That is only safe if a missing anchor stops it.
  const sql = readFileSync(
    new URL('../src/db/migrations/2026-09-12-salary-usd.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /refusing to guess/);
  assert.match(sql, /raise exception/);
});
