import { describe, expect, it } from 'vitest';
import { checkPriceShape, formatPrice, isZeroDecimal, prettyPrice } from '../src/kernel/index.js';

/**
 * The mechanical half of pricing — the half that kept failing under a human decision.
 *
 * Deciding what to charge in each country is the user's judgement and stays that way. What
 * this covers is what went wrong *around* that judgement: prices that read as arithmetic
 * rather than as prices, and amounts App Store Connect has no price point for, which it
 * rejects after a table of 175 numbers has already been approved.
 */
describe('what a price should look like', () => {
  it('knows which currencies have no fractional part', () => {
    for (const currency of ['JPY', 'KRW', 'CLP', 'VND', 'HUF', 'ISK', 'IDR']) {
      expect(isZeroDecimal(currency), currency).toBe(true);
    }
    for (const currency of ['EUR', 'USD', 'GBP', 'INR', 'BRL', 'MXN']) {
      expect(isZeroDecimal(currency), currency).toBe(false);
    }
  });

  it('turns arithmetic into prices, in currencies with cents', () => {
    // The exact complaint: "1,82 no es valido. Pondrias ya 1,99".
    // Each of these is a price the user rejected, with the number they asked for instead.
    expect(prettyPrice(1.82, 'EUR')).toBe(1.99);
    expect(prettyPrice(5.09, 'EUR')).toBe(4.99);
    expect(prettyPrice(8.49, 'EUR')).toBe(8.99);
    expect(prettyPrice(9.9, 'EUR')).toBe(9.99);
    // `.49` and `.95` are not alternatives here; they were rejected just as firmly.
    expect(prettyPrice(18.5, 'EUR')).toBe(18.99);
  });

  it('turns arithmetic into prices, in currencies without cents', () => {
    // "233 rupias se redondea a 249" — the shape scales with the magnitude.
    expect(prettyPrice(203, 'JPY')).toBe(199);
    expect(prettyPrice(2530, 'JPY')).toBe(2499);
    expect(prettyPrice(47, 'JPY')).toBe(49);
    expect(prettyPrice(300, 'JPY')).toBe(299);
    // This is the *nearest* conventional price, not a whole pricing ladder: a user who
    // wants 249 rather than 229 for their market writes 249, and it is left alone.
    expect(prettyPrice(233, 'JPY')).toBe(229);
  });

  it('leaves a price that is already right exactly alone', () => {
    for (const [amount, currency] of [
      [1.99, 'EUR'],
      [4.99, 'USD'],
      [0.99, 'GBP'],
      [199, 'JPY'],
      [2999, 'KRW'],
    ] as const) {
      expect(prettyPrice(amount, currency), `${amount} ${currency}`).toBe(amount);
      expect(checkPriceShape(formatPrice(amount, currency), currency).conventional).toBe(true);
    }
  });

  it('never rounds a customer’s price down on a tie', () => {
    // A rounding rule has no business deciding to charge less than the user chose.
    expect(prettyPrice(1.74, 'EUR')).toBe(1.99);
  });

  it('formats to what the store expects for the currency', () => {
    expect(formatPrice(1.99, 'EUR')).toBe('1.99');
    expect(formatPrice(199, 'JPY')).toBe('199');
    expect(formatPrice(199.4, 'JPY')).toBe('199');
  });

  it('reports rather than corrects, and names the alternative', () => {
    const odd = checkPriceShape('1.82', 'EUR');
    expect(odd.conventional).toBe(false);
    expect(odd.suggestion).toBe('1.99');
    // The amount as written is preserved: the caller decides whether to adopt the suggestion.
    expect(odd.amount).toBe('1.82');
  });

  it('does not trip over a value it cannot read', () => {
    for (const amount of ['', 'free', '0', '-1']) {
      expect(checkPriceShape(amount, 'EUR').conventional).toBe(true);
    }
  });
});
