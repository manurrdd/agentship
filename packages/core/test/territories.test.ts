import { describe, expect, it } from 'vitest';
import { canonicalTerritory, findTerritory, knownTerritories } from '../src/territories.js';

/**
 * The table that reconciles two stores that name countries differently.
 *
 * Two real defects live behind these assertions. Apple speaks alpha-3 and Google alpha-2,
 * and the manifest sat between them passing whatever was typed straight through — so the
 * pricing schema's own `US` default was wrong for Apple, and an `US`/`USA` pair produced a
 * phantom extra territory. Separately, Play prices each region in its own currency, and one
 * currency taken from the base territory was stamped on every price: `IN: 199` meaning ₹199
 * was sent as 199 USD.
 */
describe('the territory table', () => {
  it('resolves a country from either code system, and case-insensitively', () => {
    for (const code of ['ES', 'es', 'ESP', 'esp', ' Es ']) {
      expect(findTerritory(code)?.alpha2).toBe('ES');
    }
    expect(findTerritory('ES')?.alpha3).toBe('ESP');
    expect(findTerritory('ESP')?.currency).toBe('EUR');
  });

  it('gives one canonical form, so a base territory cannot duplicate its own country', () => {
    expect(canonicalTerritory('US')).toBe('US');
    expect(canonicalTerritory('USA')).toBe('US');
    expect(canonicalTerritory('US')).toBe(canonicalTerritory('USA'));
  });

  it('reports an unknown territory rather than guessing one', () => {
    for (const code of ['', 'XX', 'ZZZ', 'EU', 'UK']) {
      expect(findTerritory(code)).toBeUndefined();
    }
  });

  it('prices each country in its own currency, not in the base territory’s', () => {
    expect(findTerritory('IN')?.currency).toBe('INR');
    expect(findTerritory('JP')?.currency).toBe('JPY');
    expect(findTerritory('GB')?.currency).toBe('GBP');
    expect(findTerritory('BR')?.currency).toBe('BRL');
    // The euro is shared by many countries; that is the point of a table rather than a rule.
    for (const code of ['ES', 'DE', 'FR', 'IT', 'PT', 'IE', 'NL', 'HR']) {
      expect(findTerritory(code)?.currency).toBe('EUR');
    }
  });

  it('is internally consistent: codes are unique and well formed', () => {
    const all = knownTerritories();
    expect(all.length).toBeGreaterThan(150);
    expect(new Set(all.map((t) => t.alpha2)).size).toBe(all.length);
    expect(new Set(all.map((t) => t.alpha3)).size).toBe(all.length);
    for (const territory of all) {
      expect(territory.alpha2).toMatch(/^[A-Z]{2}$/);
      expect(territory.alpha3).toMatch(/^[A-Z]{3}$/);
      expect(territory.currency).toMatch(/^[A-Z]{3}$/);
      // Round-tripping through either code system must land on the same country.
      expect(findTerritory(territory.alpha3)).toEqual(territory);
      expect(findTerritory(territory.alpha2)).toEqual(territory);
    }
  });

  it('covers the countries the sessions actually priced', () => {
    // Every territory named in the real HabitQuest/Subtrack pricing work.
    for (const code of ['US', 'ES', 'IN', 'PK', 'AL', 'AF', 'BA', 'MK', 'DE', 'MX', 'BR', 'JP']) {
      expect(findTerritory(code), code).toBeDefined();
    }
  });
});
