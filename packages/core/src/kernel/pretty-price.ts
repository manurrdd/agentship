import { findTerritory } from '../territories.js';

/**
 * What a price is allowed to look like.
 *
 * Deciding *what* to charge in Poland is a judgement about that market, and Agentship does
 * not make it — users who tried to have it made for them got Albania priced above the United
 * States. What Agentship can do is the mechanical half that kept going wrong underneath the
 * judgement:
 *
 * - **A price has to look like a price.** `1.82` and `253` are arithmetic, not prices; nobody
 *   ships them. The conventional endings are `.99`, `.49`, `.95` and round hundreds — and
 *   they differ by currency, because `199` is a normal rupee price and `1.99` is a normal
 *   euro one.
 * - **Apple only sells at its own price points.** A number outside that ladder is not a
 *   cheaper price, it is a rejected request — and it was rejected at apply time, after the
 *   user had already approved a table of 175 numbers. Google takes anything.
 * - **Neither of those is a reason to overrule the user.** A price that looks unusual is
 *   reported with the nearest conventional one beside it; it is replaced only when the
 *   manifest asks for that with `rounding: pretty`.
 *
 * The zero-decimal list is the load-bearing data here: charging 199 in a currency that has
 * cents means something very different from charging 199 in one that does not.
 */

/**
 * Currencies the stores price in whole units. Sending `1.99` here would be a rounding error
 * or a hundredfold mistake, depending on which way the store reads it.
 */
const ZERO_DECIMAL: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'COP',
  'DJF',
  'GNF',
  'HUF',
  'IDR',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'LAK',
  'MGA',
  'PYG',
  'RWF',
  'TWD',
  'UGX',
  'UZS',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** True when the store quotes this currency without a fractional part. */
export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(currency.toUpperCase());
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The conventional price nearest to `amount` in `currency`.
 *
 * For a currency with cents this is the closest of `x.99`, `x.49`, `x.95` and `x.00`. For a
 * whole-unit currency it is the closest number ending in a conventional run of nines or a
 * round hundred, at a magnitude that suits the amount: `203` becomes `199`, `2530` becomes
 * `2499`, `47` becomes `49`.
 */
export function prettyPrice(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount <= 0) return amount;

  if (!isZeroDecimal(currency)) {
    // `.99` and nothing else. It is not the only ending in the world, but it is the one this
    // rule is for: `.49` and `.95` were rejected just as firmly as `.82` by the user whose
    // complaints this implements — "8,49 tampoco, para eso pones 8,99".
    const whole = Math.floor(amount);
    const candidates = [whole - 1 + 0.99, whole + 0.99, whole + 1.99]
      .map(round2)
      .filter((candidate) => candidate > 0);
    return nearest(amount, candidates);
  }

  // Whole-unit currencies: the same shape, scaled. A price of 47 wants 49, one of 203 wants
  // 199, one of 2530 wants 2499 — a run of nines at the magnitude the amount is written in.
  const digits = Math.max(1, Math.floor(Math.log10(amount)) + 1);
  const step = 10 ** Math.max(1, digits - 2);
  const base = Math.round(amount / step) * step;
  const candidates = [base - step, base, base + step]
    .map((candidate) => candidate - 1)
    .filter((candidate) => candidate > 0);
  return nearest(amount, [...new Set(candidates)]);
}

function nearest(amount: number, candidates: readonly number[]): number {
  let best = candidates[0] ?? amount;
  for (const candidate of candidates) {
    const better = Math.abs(candidate - amount) < Math.abs(best - amount);
    // Ties go to the higher price: rounding a customer's price down by a rounding rule is a
    // decision about the user's revenue that a rounding rule has no business making.
    const tie = Math.abs(candidate - amount) === Math.abs(best - amount) && candidate > best;
    if (better || tie) best = candidate;
  }
  return best;
}

/** Formats a price the way the store expects it for this currency. */
export function formatPrice(amount: number, currency: string): string {
  return isZeroDecimal(currency) ? String(Math.round(amount)) : amount.toFixed(2);
}

export interface PriceShapeCheck {
  /** The price as written. */
  readonly amount: string;
  readonly currency: string;
  /** True when the amount already looks like a price someone would ship. */
  readonly conventional: boolean;
  /** The nearest conventional price, formatted; equal to `amount` when already fine. */
  readonly suggestion: string;
}

/**
 * Whether a price looks shippable, and what it would be if not.
 *
 * Reports rather than corrects. The caller decides whether to warn the user or, when the
 * manifest asked for rounding, to adopt the suggestion — and either way the number the user
 * approves is the number that reaches the store.
 */
export function checkPriceShape(amount: string, currency: string): PriceShapeCheck {
  const parsed = Number.parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { amount, currency, conventional: true, suggestion: amount };
  }
  const pretty = prettyPrice(parsed, currency);
  const suggestion = formatPrice(pretty, currency);
  // Compared as formatted text: `4.99` and `4.990000000001` are the same price, and a float
  // comparison here would flag prices that are already exactly right.
  return {
    amount,
    currency,
    conventional: formatPrice(parsed, currency) === suggestion,
    suggestion,
  };
}

/** The currency a territory's price is quoted in, or `undefined` for an unknown territory. */
export function currencyOfTerritory(territory: string): string | undefined {
  return findTerritory(territory)?.currency;
}
