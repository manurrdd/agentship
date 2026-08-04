import { saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Journey } from '../src/journey.js';
import { monetizedManifest } from '../src/manifests.js';

/**
 * Money, end to end.
 *
 * A mistake in this journey costs the user real money or real customers, so the scenario
 * is written around the guarantees rather than the happy path: nothing priced without an
 * approval bound to that exact diff, no product created twice however many times the run
 * is repeated or interrupted, and no product ever removed because the manifest forgot it.
 */
describe('a monetisation catalog, from nothing to converged', () => {
  let journey: Journey | undefined;
  afterEach(async () => {
    await journey?.cleanup();
    journey = undefined;
  });

  for (const store of ['apple', 'google'] as const) {
    it(`${store}: creates and prices every declared product exactly once`, async () => {
      journey = await Journey.start({
        stores: [store],
        manifest: monetizedManifest({ stores: [store], track: 'internal_testing' }),
      });
      const adapter = journey.adapter(store);

      const plan = await journey.plan();
      const money = plan.actions.filter(
        (action) => action.kind === 'create_product' || action.kind === 'set_product_pricing',
      );
      expect(money).toHaveLength(4);
      for (const action of money) expect(action.classification).toBe('needs_approval');

      // Applying with no approvals is the normal "make progress while we discuss" call.
      await journey.apply(plan, []);
      expect(adapter.effects.productCreates).toBe(0);
      expect(adapter.effects.productPriceWrites).toBe(0);

      const converged = await journey.driveToConvergence();
      expect(converged.converged, journey.render()).toBe(true);
      expect(adapter.effects.productCreates).toBe(2);
      expect(adapter.effects.productPriceWrites).toBe(2);
      expect(adapter.state.products.get('com.example.mock.pro.monthly')?.prices.get('US')).toBe(
        '4.99',
      );

      // The process dies and the agent starts again: nothing is created a second time.
      await journey.kill();
      const second = await journey.driveToConvergence();
      expect(second.converged, journey.render()).toBe(true);
      expect(adapter.effects.productCreates).toBe(2);
      expect(adapter.effects.productPriceWrites).toBe(2);
    });
  }

  it('shows every converted territory before a single price is written', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: monetizedManifest({
        extra: {
          monetization: {
            products: [
              {
                id: 'coins',
                type: 'consumable',
                apple: { productId: 'com.example.mock.coins' },
                names: { 'en-US': { displayName: 'Coins' } },
                price: { base: '2.00', baseTerritory: 'US', strategy: 'convert' },
              },
            ],
          },
        },
      }),
    });

    const plan = await journey.plan({ detail: 'full' });
    const pricing = plan.actions.find((action) => action.kind === 'set_product_pricing') as
      | { diff?: { path: string }[] }
      | undefined;
    const paths = (pricing?.diff ?? []).map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'products.coins.price.US',
        'products.coins.price.GB',
        'products.coins.price.JP',
      ]),
    );
  });

  it('changes a price only against the new diff, never against the old approval', async () => {
    journey = await Journey.start({ stores: ['apple'], manifest: monetizedManifest() });
    const apple = journey.adapter('apple');

    // The agent has a plan in hand and the user is still thinking about it.
    const plan = await journey.plan();
    const staleApprovals = plan.approvalsRequired;
    expect(staleApprovals.length).toBeGreaterThan(0);

    // …and then raises the price in the manifest before answering.
    await saveManifest(
      journey.repoRoot,
      monetizedManifest({
        extra: {
          monetization: {
            products: [
              {
                id: 'pro_monthly',
                type: 'subscription',
                period: 'one_month',
                apple: { productId: 'com.example.mock.pro.monthly', group: 'Pro', level: 1 },
                names: { 'en-US': { displayName: 'Mock Pro' } },
                price: { base: '5.99', baseTerritory: 'US', strategy: 'manual' },
              },
            ],
          },
        },
      }),
    );

    // The old approvals no longer describe what would happen, so no price is written and
    // the ids come back as stale for the agent to re-present.
    const applied = await journey.apply(plan, staleApprovals);
    expect(apple.effects.productPriceWrites, journey.render()).toBe(0);
    expect(applied.payload['staleApprovals']).not.toEqual([]);
    expect(applied.plan.actions.some((action) => action.kind === 'set_product_pricing')).toBe(true);

    // Approved against the fresh diff, it lands.
    await journey.driveToConvergence();
    expect(apple.state.products.get('com.example.mock.pro.monthly')?.prices.get('US')).toBe('5.99');
  });

  it('reports a product the store has and the manifest does not, and removes nothing', async () => {
    journey = await Journey.start({
      stores: ['apple'],
      manifest: monetizedManifest({ extra: { monetization: { products: [] } } }),
      state: () => ({
        products: new Map([
          [
            'com.example.mock.legacy',
            {
              id: 'p-legacy',
              productId: 'com.example.mock.legacy',
              kind: 'non_consumable' as const,
              prices: new Map([['US', '2.99']]),
              offers: [],
              state: 'approved',
            },
          ],
        ]),
      }),
    });

    const plan = await journey.plan();
    expect(
      plan.actions.find((action) => action.kind === 'review_product_drift')?.classification,
    ).toBe('needs_input');

    await journey.driveToConvergence();
    // A product customers may already own is never deleted by a tool.
    expect(journey.adapter('apple').state.products.has('com.example.mock.legacy')).toBe(true);
  });
});
