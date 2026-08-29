/**
 * Salary extraction from description text.
 *
 * Only one of five providers (Lever) publishes a structured salary range, so
 * 1,158 of 1,172 roles showed no pay at all and the salary sort was effectively
 * sorting fourteen jobs. The figures are almost always present — just written in
 * prose rather than exposed as a field.
 *
 * Precision matters more than recall here: a wrong salary is worse than none,
 * because the user cannot tell it is wrong. Every match therefore has to clear
 * a currency or pay-context signal AND land inside a plausible range.
 */

export interface ParsedSalary {
  min?: number;
  max?: number;
  currency: string;
  /** Normalized to annual; hourly and monthly figures are converted. */
  period: 'year';
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR', 'C$': 'CAD', 'A$': 'AUD',
};

const CURRENCY_CODES = /\b(USD|GBP|EUR|CAD|AUD|INR|SGD|CHF|SEK|DKK|NOK|PLN)\b/i;

/**
 * Text that must appear near the numbers. Without this, "$50M Series C" and
 * "401(k)" both parse as salaries.
 */
const PAY_CONTEXT =
  /\b(salary|compensation|pay|base|range|rate|earn|remuneration|package|per (hour|year|annum)|annually|hourly|OTE)\b/i;

/** Phrases whose numbers are never a salary. */
const ANTI_CONTEXT =
  /\b(401\s*\(?k\)?|revenue|funding|raised|valuation|series [a-e]\b|arr\b|market cap|budget of|equity value)\b/i;

const ANNUAL_MIN = 15_000;
const ANNUAL_MAX = 1_200_000;
const HOURLY_MIN = 8;
const HOURLY_MAX = 400;

/** "150,000" | "150k" | "150.5k" -> number */
function toNumber(raw: string): number | undefined {
  const cleaned = raw.replace(/,/g, '').trim();
  const kMatch = /^(\d+(?:\.\d+)?)\s*[kK]$/.exec(cleaned);
  if (kMatch?.[1]) return Math.round(Number(kMatch[1]) * 1000);
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function detectCurrency(window: string): string {
  const code = CURRENCY_CODES.exec(window);
  if (code?.[1]) return code[1].toUpperCase();
  for (const [symbol, iso] of Object.entries(CURRENCY_SYMBOLS)) {
    if (window.includes(symbol)) return iso;
  }
  return 'USD';
}

/** Hourly and monthly figures are annualized so every row is comparable. */
function annualize(value: number, window: string): number | undefined {
  if (/\b(per hour|hourly|\/\s*hour|\/\s*hr|an hour)\b/i.test(window)) {
    if (value < HOURLY_MIN || value > HOURLY_MAX) return undefined;
    return Math.round(value * 2080); // 40h x 52 weeks
  }
  if (/\b(per month|monthly|\/\s*month|a month)\b/i.test(window)) {
    const annual = value * 12;
    return annual >= ANNUAL_MIN && annual <= ANNUAL_MAX ? Math.round(annual) : undefined;
  }
  return value >= ANNUAL_MIN && value <= ANNUAL_MAX ? Math.round(value) : undefined;
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*[kK]|\d{2,7}`;
const RANGE = new RegExp(
  String.raw`([$£€₹]|\b(?:USD|GBP|EUR|CAD|AUD|INR)\b)?\s*(${NUM})\s*(?:-|–|—|to|and)\s*([$£€₹])?\s*(${NUM})`,
  'gi',
);
const SINGLE = new RegExp(String.raw`([$£€₹])\s*(${NUM})`, 'gi');

/**
 * Returns the first defensible pay range found, or undefined.
 *
 * Ranges are preferred over single figures: "between $150,000 and $190,000" is
 * unambiguous, whereas a lone "$150,000" could be a bonus cap or an equity note.
 */
export function parseSalary(description: string | undefined): ParsedSalary | undefined {
  if (!description) return undefined;
  const text = description.slice(0, 8000);
  let rejectedRange = false;

  for (const match of text.matchAll(RANGE)) {
    const at = match.index ?? 0;
    // A window around the match decides whether these numbers are pay at all.
    const window = text.slice(Math.max(0, at - 140), at + match[0].length + 90);
    if (ANTI_CONTEXT.test(window)) continue;
    if (!PAY_CONTEXT.test(window) && !/[$£€₹]/.test(match[0])) continue;

    const rawLo = toNumber(match[2] ?? '');
    const rawHi = toNumber(match[4] ?? '');
    if (rawLo === undefined || rawHi === undefined) continue;

    const lo = annualize(rawLo, window);
    const hi = annualize(rawHi, window);
    if (lo === undefined || hi === undefined) continue;
    // A "range" that runs backwards, or spans more than 5x, is not a pay band.
    if (hi < lo || hi > lo * 5) {
      rejectedRange = true;
      continue;
    }

    return { min: lo, max: hi, currency: detectCurrency(window), period: 'year' };
  }

  // Fall back to a single figure only when the sentence is explicitly about pay
  // AND no range was already rejected as implausible.
  if (rejectedRange) return undefined;
  for (const match of text.matchAll(SINGLE)) {
    const at = match.index ?? 0;
    const window = text.slice(Math.max(0, at - 140), at + match[0].length + 90);
    if (ANTI_CONTEXT.test(window)) continue;
    if (!PAY_CONTEXT.test(window)) continue;

    const raw = toNumber(match[2] ?? '');
    if (raw === undefined) continue;
    const value = annualize(raw, window);
    if (value === undefined) continue;

    return { min: value, max: value, currency: detectCurrency(window), period: 'year' };
  }

  return undefined;
}
