import { ManifestSchema, saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { actionsOf, createMcpHarness, type McpHarness, outcomesOf } from './helpers.js';

/**
 * A monetisation catalog from nothing to converged, through the real MCP surface.
 *
 * The properties under test are the ones a mistake here would cost real money:
 *
 * - a product is created and priced through two separate approvals;
 * - no price is ever applied without an approval, not even with an empty approval list;
 * - a second plan against the same store is empty (idempotence by convergence);
 * - a product the store holds and the manifest does not is reported, never deleted.
 */
function monetizedManifest(overrides: Record<string, unknown> = {}) {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: { apple: { bundleId: 'com.example.mock', appId: 'app-1' } },
    release: { version: '1.1.0', buildNumber: '42', track: 'internal_testing' },
    metadata: {
      primaryLocale: 'en-US',
      locales: { 'en-US': { name: 'Mock App', description: 'The original text.' } },
    },
    monetization: {
      products: [
        {
          id: 'pro_monthly',
          type: 'subscription',
          period: 'one_month',
          apple: { productId: 'com.example.mock.pro.monthly', group: 'Pro', level: 1 },
          google: { productId: 'com.example.mock.pro.monthly', basePlan: 'monthly' },
          names: { 'en-US': { displayName: 'Mock Pro', description: 'Everything, monthly.' } },
          price: { base: '4.99', baseTerritory: 'US', strategy: 'manual' },
        },
        {
          id: 'coins',
          type: 'consumable',
          apple: { productId: 'com.example.mock.coins' },
          google: { productId: 'com.example.mock.coins' },
          names: { 'en-US': { displayName: 'Coins' } },
          price: { base: '0.99', baseTerritory: 'US', strategy: 'manual' },
        },
      ],
    },
    ...overrides,
  });
}

async function driveToConvergence(harness: McpHarness, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as {
      planId: string;
      approvalsRequired: string[];
      actions: unknown[];
    };
    if (plan.actions.length === 0) return;
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    if (!outcomesOf(applied.payload).some((outcome) => outcome.status === 'done')) return;
  }
}

describe('a monetisation catalog from zero', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  for (const store of ['apple', 'google'] as const) {
    it(`${store}: creates and prices every declared product, then converges`, async () => {
      harness = await createMcpHarness({
        stores: [store],
        manifest: monetizedManifest(
          store === 'google'
            ? {
                stores: { google: { packageName: 'com.example.mock' } },
                release: {
                  version: '1.1.0',
                  buildNumber: '42',
                  track: 'internal_testing',
                  artifacts: { google: { path: 'artifacts/app.aab', kind: 'aab' } },
                },
              }
            : {},
        ),
      });
      const adapter = harness.adapters.get(store);

      const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
      const actions = actionsOf(planned.payload);
      const productActions = actions.filter(
        (action) => action.kind === 'create_product' || action.kind === 'set_product_pricing',
      );
      expect(productActions).toHaveLength(4);
      // Money is never `auto`, whatever the capability table says.
      for (const action of productActions) expect(action.classification).toBe('needs_approval');

      await driveToConvergence(harness);
      expect(adapter?.effects.productCreates).toBe(2);
      expect(adapter?.effects.productPriceWrites).toBe(2);
      expect(adapter?.state.products.get('com.example.mock.pro.monthly')?.prices.get('US')).toBe(
        '4.99',
      );

      // Converged: a fresh plan has nothing left to say about products.
      const after = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
      expect(
        actionsOf(after.payload).filter((action) => action.kind.includes('product')),
      ).toHaveLength(0);
      // And a second pass creates nothing twice.
      await driveToConvergence(harness);
      expect(adapter?.effects.productCreates).toBe(2);
    });
  }

  it('never sets a price without an approval, even when everything else runs', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: monetizedManifest() });
    const apple = harness.adapters.get('apple');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string };
    // The normal "make progress while approvals are discussed" call: no approvals at all.
    const applied = await harness.call('agentship_apply', { planId: plan.planId, approvals: [] });

    expect(apple?.effects.productCreates).toBe(0);
    expect(apple?.effects.productPriceWrites).toBe(0);
    const withheld = outcomesOf(applied.payload).filter(
      (outcome) => outcome.status === 'needs_approval',
    );
    expect(withheld.length).toBeGreaterThan(0);
  });

  it('changes a price only after the new diff is approved', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: monetizedManifest() });
    const apple = harness.adapters.get('apple');
    await driveToConvergence(harness);
    const before = apple?.effects.productPriceWrites ?? 0;

    await saveManifest(
      harness.repoRoot,
      monetizedManifest({
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
      }),
    );

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const pricing = actionsOf(planned.payload).find(
      (action) => action.kind === 'set_product_pricing',
    );
    expect(pricing?.classification).toBe('needs_approval');
    const plan = planned.payload['plan'] as { planId: string };

    // Applying without that id changes nothing.
    await harness.call('agentship_apply', { planId: plan.planId, approvals: [] });
    expect(apple?.effects.productPriceWrites).toBe(before);

    await driveToConvergence(harness);
    expect(apple?.state.products.get('com.example.mock.pro.monthly')?.prices.get('US')).toBe(
      '5.99',
    );
  });

  it('reports a product the store has and the manifest does not, without removing it', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: monetizedManifest({ monetization: { products: [] } }),
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
    const apple = harness.adapters.get('apple');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const drift = actionsOf(planned.payload).find(
      (action) => action.kind === 'review_product_drift',
    );
    expect(drift?.classification).toBe('needs_input');

    await driveToConvergence(harness);
    // Still there. A product customers may own is never deleted by a tool.
    expect(apple?.state.products.has('com.example.mock.legacy')).toBe(true);
  });

  it('shows every converted territory in the diff before pricing anything', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: monetizedManifest({
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
      }),
    });

    const planned = await harness.call('agentship_plan', {
      projectDir: harness.repoRoot,
      detail: 'full',
    });
    const pricing = actionsOf(planned.payload).find(
      (action) => action.kind === 'set_product_pricing',
    ) as { diff?: { path: string; after?: unknown }[] } | undefined;
    const paths = (pricing?.diff ?? []).map((entry) => entry.path);
    // The mock's conversion table: the user sees GB, JP and MX before approving, not after.
    expect(paths).toEqual(
      expect.arrayContaining([
        'products.coins.price.US',
        'products.coins.price.GB',
        'products.coins.price.JP',
      ]),
    );
  });
});
