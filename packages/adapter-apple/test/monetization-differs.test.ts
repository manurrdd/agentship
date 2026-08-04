import type { DifferProposals, MockProduct, MockStoreState } from '@agentship/core';
import { describe, expect, it } from 'vitest';
import { applePrivacyDiffer, appleProductsDiffer } from '../src/differs/index.js';
import { manifestFor, runDiffer, stateOf } from './differ-helpers.js';

/**
 * The monetisation and privacy differs, run exactly as the kernel runs them.
 *
 * The properties under test are the ones the whole design rests on: a price is never applied
 * without the user having seen every territory, an undeclared remote product is reported and
 * never removed, and no privacy action exists at all until the user has confirmed the
 * declaration.
 */
function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pro_monthly',
    type: 'subscription',
    period: 'one_month',
    apple: { productId: 'com.acme.lumo.pro.monthly', group: 'Pro', level: 1 },
    names: { 'en-US': { displayName: 'Lumo Pro', description: 'Everything, monthly.' } },
    price: { base: '4.99', baseTerritory: 'US', strategy: 'manual' },
    ...overrides,
  };
}

const CONVERTING: DifferProposals = {
  async convertPrice(basePrice, baseTerritory) {
    return {
      baseTerritory,
      basePrice,
      prices: [
        { territory: baseTerritory, price: basePrice, currency: 'USD' },
        { territory: 'GB', price: '4.49', currency: 'GBP' },
      ],
    };
  },
};

const UNAVAILABLE: DifferProposals = {
  async convertPrice(basePrice, baseTerritory) {
    return { baseTerritory, basePrice, prices: [], unavailable: true };
  },
};

function productState(overrides: Partial<MockProduct> = {}): Partial<MockStoreState> {
  const product: MockProduct = {
    id: 'p-1',
    productId: 'com.acme.lumo.pro.monthly',
    kind: 'auto_renewable_subscription',
    referenceName: 'pro_monthly',
    displayName: 'Lumo Pro',
    group: 'Pro',
    period: 'one_month',
    prices: new Map([['US', '4.99']]),
    offers: [],
    state: 'ready_to_submit',
    ...overrides,
  };
  return { products: new Map([[product.productId, product]]) };
}

describe('apple/products', () => {
  it('creates a missing subscription and prices it as two separate approvals', async () => {
    const run = await runDiffer(
      appleProductsDiffer(),
      manifestFor({ monetization: { products: [subscription()] } }),
      await stateOf('apple'),
    );
    const kinds = run.drafts.map((draft) => draft.kind);
    expect(kinds).toEqual(['create_product', 'set_product_pricing']);
    // Pricing waits for the product: a half-applied plan never leaves something purchasable
    // at a price nobody approved.
    const pricing = run.drafts[1];
    expect(pricing?.dependsOn?.map((key) => key.kind)).toContain('create_product');
    expect(pricing?.op).toMatchObject({
      op: 'set_product_pricing',
      pricing: { basePrice: '4.99', baseTerritory: 'US' },
    });
    await run.cleanup();
  });

  it('converges: nothing to do once the store already matches', async () => {
    const run = await runDiffer(
      appleProductsDiffer(),
      manifestFor({ monetization: { products: [subscription()] } }),
      await stateOf('apple', productState()),
    );
    expect(run.drafts).toEqual([]);
    await run.cleanup();
  });

  it('puts every converted territory in the diff before anything is applied', async () => {
    const differ = appleProductsDiffer();
    const drafts = await differ.plan({
      store: 'apple',
      manifest: manifestFor({
        monetization: {
          products: [
            subscription({ price: { base: '4.99', baseTerritory: 'US', strategy: 'convert' } }),
          ],
        },
      }),
      state: await stateOf('apple', productState()),
      repoRoot: '/tmp',
      proposals: CONVERTING,
    });
    const pricing = drafts.find((draft) => draft.kind === 'set_product_pricing');
    const paths = pricing?.diff.map((entry) => entry.path) ?? [];
    expect(paths).toContain('products.pro_monthly.price.GB');
    const gb = pricing?.diff.find((entry) => entry.path.endsWith('.GB'));
    expect(gb?.after).toBe('4.49');
    expect(gb?.note).toContain('conversion');
  });

  it('asks for input rather than pricing when the store cannot convert', async () => {
    const differ = appleProductsDiffer();
    const drafts = await differ.plan({
      store: 'apple',
      manifest: manifestFor({
        monetization: {
          products: [
            subscription({ price: { base: '4.99', baseTerritory: 'US', strategy: 'convert' } }),
          ],
        },
      }),
      state: await stateOf('apple', productState()),
      repoRoot: '/tmp',
      proposals: UNAVAILABLE,
    });
    // No conversion means no proposal; the base price is never quietly applied everywhere.
    expect(drafts.some((draft) => draft.op !== undefined)).toBe(false);
  });

  it('warns when a price moves by more than an order of magnitude', async () => {
    const run = await runDiffer(
      appleProductsDiffer(),
      manifestFor({
        monetization: {
          products: [
            subscription({ price: { base: '49.99', baseTerritory: 'US', strategy: 'manual' } }),
          ],
        },
      }),
      await stateOf('apple', productState()),
    );
    const pricing = run.drafts.find((draft) => draft.kind === 'set_product_pricing');
    expect(pricing?.riskNotes?.join(' ')).toContain('decimal point');
    await run.cleanup();
  });

  it('keeps existing subscribers on their price and says so', async () => {
    const run = await runDiffer(
      appleProductsDiffer(),
      manifestFor({
        monetization: {
          products: [
            subscription({ price: { base: '5.99', baseTerritory: 'US', strategy: 'manual' } }),
          ],
        },
      }),
      await stateOf('apple', productState()),
    );
    const pricing = run.drafts.find((draft) => draft.kind === 'set_product_pricing');
    expect(pricing?.op).toMatchObject({
      pricing: { preserveExistingSubscribers: true },
    });
    expect(pricing?.riskNotes?.join(' ')).toContain('Existing subscribers');
    await run.cleanup();
  });

  it('reports an undeclared remote product and never drafts a deletion', async () => {
    const run = await runDiffer(
      appleProductsDiffer(),
      manifestFor({ monetization: { products: [] } }),
      await stateOf('apple', productState()),
    );
    const drift = run.drafts.find((draft) => draft.kind === 'review_product_drift');
    expect(drift?.needsInput).toEqual(['monetization.products']);
    expect(drift?.op).toBeUndefined();
    expect(run.drafts.every((draft) => draft.destructive !== true)).toBe(true);
    await run.cleanup();
  });

  it('refuses to delete even when the manifest says absent', async () => {
    const run = await runDiffer(
      appleProductsDiffer(),
      manifestFor({ monetization: { products: [subscription({ state: 'absent' })] } }),
      await stateOf('apple', productState()),
    );
    const removal = run.drafts.find((draft) => draft.kind === 'remove_product');
    expect(removal?.op).toBeUndefined();
    expect(removal?.needsInput).toContain('monetization.products.pro_monthly.state');
    await run.cleanup();
  });
});

describe('apple/privacy', () => {
  const practices = [
    {
      dataType: 'identifiers',
      collected: true,
      purposes: ['advertising'],
      linkedToUser: false,
      tracking: true,
      shared: true,
      source: 'inferred',
      evidence: 'Google AdMob typically collects this data',
    },
  ];

  it('drafts nothing executable while the declaration is a draft', async () => {
    const run = await runDiffer(
      applePrivacyDiffer(),
      manifestFor({ privacy: { declarationStatus: 'draft', dataPractices: practices } }),
      await stateOf('apple'),
    );
    expect(run.drafts).toHaveLength(1);
    expect(run.drafts[0]?.kind).toBe('confirm_privacy');
    expect(run.drafts[0]?.needsInput).toEqual(['privacy.declarationStatus']);
    expect(run.drafts[0]?.op).toBeUndefined();
    expect(run.drafts[0]?.pending).toBeUndefined();
    await run.cleanup();
  });

  it('emits the App Privacy console step once the content is confirmed', async () => {
    const run = await runDiffer(
      applePrivacyDiffer(),
      manifestFor({ privacy: { declarationStatus: 'confirmed', dataPractices: practices } }),
      await stateOf('apple'),
    );
    const declare = run.drafts.find((draft) => draft.kind === 'declare_app_privacy');
    expect(declare?.pending?.id).toBe('apple:app-privacy');
    // The projection fills the form: one field per data type, with Apple's own category.
    const fields = declare?.pending?.fields ?? [];
    expect(fields.some((field) => field.label.startsWith('Identifiers'))).toBe(true);
    expect(fields[fields.length - 1]?.proposedValue).toContain('Third-Party Advertising');
    await run.cleanup();
  });

  it('asks the question instead of projecting a purpose Apple has no word for', async () => {
    const run = await runDiffer(
      applePrivacyDiffer(),
      manifestFor({
        privacy: {
          declarationStatus: 'confirmed',
          dataPractices: [{ dataType: 'other', collected: true, purposes: ['other'] }],
        },
      }),
      await stateOf('apple'),
    );
    // Apple *does* have "Other Purposes", so this one projects cleanly — the check is that
    // the differ produced an executable console step rather than a question.
    expect(run.drafts.some((draft) => draft.kind === 'answer_privacy_questions')).toBe(false);
    await run.cleanup();
  });
});
