/**
 * Comparing pay across currencies, for ordering and for sanity — never for display.
 *
 * THE BUG THIS EXISTS FOR
 *
 * "Highest paid" sorted on the raw number with no regard to currency:
 *
 *   order by coalesce(salary_max, salary_min, -1) desc
 *
 * Measured on the live corpus, 12 September 2026. One employer, Weekdayworks,
 * publishes 19 postings in RUPEES — ₹500,000 to ₹10,000,000, which is an
 * ordinary Indian range of roughly $6k to $120k. ₹10,000,000 beats every real
 * dollar salary on the site, so those 19 jobs owned the entire first page of
 * "highest paid", apparently offering $10 million for a frontend engineer.
 *
 * 22 INR postings in total, plus PLN, SEK, DKK, MXN, CZK and CHF — all competing
 * directly against dollars on magnitude alone.
 *
 * AND THE SECOND BUG IT ALSO FIXES
 *
 * The plausibility check on salaries had a floor and no ceiling:
 *
 *   if (value >= 15_000) return Math.round(value);
 *
 * So "Gage PBL Test Job" at Reteam stored $27,924,000, and a policy fellowship
 * stored $15,600,000. A floor without a ceiling only catches half the nonsense.
 * The ceiling has to be currency-aware or it would throw away every legitimate
 * rupee salary, which is how a fix becomes a worse bug.
 *
 * APPROXIMATE RATES, ON PURPOSE
 *
 * These are rough and they will drift, and that is fine, because they are used
 * for exactly two things: deciding which of two salaries is larger, and deciding
 * whether a number is absurd. Neither needs precision — being 10% out never
 * changes whether ₹10,000,000 outranks $400,000, and never changes whether
 * $27,924,000 is a real salary.
 *
 * What they are NEVER used for is showing a figure to anyone. A converted number
 * on a job card would be an invented number, which this project does not do: the
 * card shows what the employer published, in the currency they published it in.
 *
 * A rate that is absent is treated as USD, which is the least surprising
 * assumption for a feed whose median posting is American — and the plausibility
 * ceiling then catches anything wildly out of range anyway.
 */

/** Units of each currency per one US dollar. Approximate, mid-2026. */
const PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.37,
  AUD: 1.52,
  CHF: 0.88,
  SGD: 1.34,
  INR: 84,
  JPY: 150,
  CNY: 7.2,
  MXN: 18,
  BRL: 5.4,
  ZAR: 18.5,
  SEK: 10.6,
  NOK: 10.8,
  DKK: 6.9,
  PLN: 3.9,
  CZK: 23,
  HUF: 360,
  RON: 4.6,
  TRY: 34,
  ILS: 3.7,
  AED: 3.67,
  SAR: 3.75,
  NZD: 1.64,
  HKD: 7.8,
  KRW: 1_350,
  TWD: 32,
  THB: 35,
  PHP: 57,
  IDR: 15_800,
  VND: 25_000,
  MYR: 4.4,
  COP: 4_000,
  CLP: 950,
  ARS: 1_000,
  PKR: 278,
  BDT: 120,
  LKR: 300,
  EGP: 49,
  NGN: 1_600,
  KES: 129,
  UAH: 41,
  RUB: 92,
};

/**
 * The same amount expressed in dollars, for comparison only.
 *
 * An unknown or absent currency is read as USD rather than dropped: the feed's
 * median posting is American, and the plausibility ceiling below catches anything
 * that assumption gets badly wrong.
 */
export function toUsd(amount: number, currency: string | null | undefined): number {
  if (!Number.isFinite(amount)) return 0;
  const code = (currency ?? 'USD').trim().toUpperCase();
  const rate = PER_USD[code];
  if (!rate || rate <= 0) return amount;
  return amount / rate;
}

/**
 * The floor, in dollars.
 *
 * Below this a figure is an hourly rate, a monthly one, or a stipend — not an
 * annual salary. Already the behaviour of the existing checks; stated here so
 * both ends of the range live in one place.
 */
export const MIN_ANNUAL_USD = 15_000;

/**
 * The ceiling, in dollars.
 *
 * Deliberately generous. The highest plausible figure seen on the live corpus is
 * an OpenAI engineering manager at $401k–445k, and the USD average maximum is
 * $182,627 — so $2,000,000 is roughly five times anything real and still rejects
 * the test posting at $27,924,000 and the fellowship at $15,600,000.
 *
 * Generous rather than tight because the alternative is deciding an employer is
 * wrong about their own pay. A number this far out is a parsing artefact or a
 * junk posting; a number merely high might be true.
 */
export const MAX_ANNUAL_USD = 2_000_000;

/**
 * Whether this could be somebody's annual pay.
 *
 * Currency-aware, which is the whole point: ₹10,000,000 is an ordinary Indian
 * salary and $10,000,000 is not, and a single numeric ceiling cannot tell them
 * apart. Applied to the converted value, never to the stored one.
 */
export function isPlausibleAnnual(amount: number, currency: string | null | undefined): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const usd = toUsd(amount, currency);
  return usd >= MIN_ANNUAL_USD && usd <= MAX_ANNUAL_USD;
}

/** The currency codes with a rate, for the SQL the ordering uses. */
export function knownCurrencies(): { code: string; perUsd: number }[] {
  return Object.entries(PER_USD).map(([code, perUsd]) => ({ code, perUsd }));
}
