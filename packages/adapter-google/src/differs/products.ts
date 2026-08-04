import type { ActionDraft, DifferInput, PlannedProduct, ResourceDiffer } from '@agentship/core';
import { planProducts, pricingSpecOf, productSpecOf } from '@agentship/core';

/**
 * `google/products` — one-time products, subscriptions, their prices and their offers.
 *
 * The same three decisions as on Apple, drafted the same way, with one Play-specific
 * property: **these actions stay out of the shared release edit**. Play's monetisation
 * endpoints (`inappproducts`, `monetization.subscriptions`) are not part of an edit at all —
 * they are their own resources — so joining `GOOGLE_EDIT_GROUP` would claim an atomicity
 * that does not exist and would break the single-batch property the release tests assert
 * through {@link groupsIntoOneBatch}.
 *
 * They are ordered *before* the release instead, by making the release depend on them where
 * it matters: a version that references a product Play does not have yet is rejected at
 * review, so the products go first and the release follows.
 */
export function googleProductsDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'products',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const plan = await planProducts(input);
      const locales = Object.keys(input.manifest.metadata.locales).sort();
      const drafts: ActionDraft[] = [];

      for (const planned of plan.products) drafts.push(...draftsFor(planned, locales));

      if (plan.drift.length > 0) {
        drafts.push({
          kind: 'review_product_drift',
          target: 'products',
          operation: 'listProducts',
          summary: `${plan.drift.length} Play product(s) are not declared in the manifest`,
          diff: plan.drift.map((product) => ({
            path: `products.${product.productId}`,
            before: product.kind,
            note: 'Present on Google Play, absent from the manifest. Agentship never deletes a product.',
          })),
          needsInput: ['monetization.products'],
          riskNotes: [
            'Declare these products in the manifest so Agentship stops reporting them, or leave them alone. Deleting a product breaks every customer who owns it, and Agentship will not do it.',
          ],
        });
      }
      return drafts;
    },
  };
}

function draftsFor(planned: PlannedProduct, locales: readonly string[]): ActionDraft[] {
  const { projection, product } = planned;
  const drafts: ActionDraft[] = [];

  if (planned.removal) {
    drafts.push({
      kind: 'remove_product',
      target: `product/${projection.productId}`,
      operation: 'updateProduct',
      summary: `Remove ${projection.productId} — a decision Agentship will not take`,
      diff: [{ path: `products.${projection.productId}`, before: product.type, after: 'absent' }],
      needsInput: [...planned.needsInput],
      riskNotes: [...planned.warnings],
    });
    return drafts;
  }

  if (planned.missing || planned.metadataDiff.length > 0) {
    const spec = productSpecOf(planned, locales);
    drafts.push({
      kind: planned.missing ? 'create_product' : 'update_product',
      target: `product/${projection.productId}`,
      operation: planned.missing ? 'createProduct' : 'updateProduct',
      summary: planned.missing
        ? `Create ${product.type} ${projection.productId}${projection.group === undefined ? '' : ` (base plan ${projection.group})`}`
        : `Update ${projection.productId}`,
      diff: [...planned.metadataDiff],
      ...(planned.needsInput.length > 0
        ? { needsInput: [...planned.needsInput] }
        : {
            op: planned.missing
              ? { op: 'create_product', product: spec }
              : { op: 'update_product', product: spec },
          }),
      riskNotes: planned.missing
        ? ['A created product is not sellable until it has a price and its base plan is active.']
        : [],
    });
  }

  if (planned.priceDiff.length > 0) {
    drafts.push({
      kind: 'set_product_pricing',
      target: `price/${projection.productId}`,
      operation: 'setProductPricing',
      summary: `Price ${projection.productId} at ${product.price.base} (${product.price.baseTerritory}) across ${Object.keys(planned.desiredPrices).length} region(s)`,
      diff: [...planned.priceDiff],
      dependsOn: [
        { kind: 'create_product', target: `product/${projection.productId}`, optional: true },
        { kind: 'update_product', target: `product/${projection.productId}`, optional: true },
      ],
      ...(planned.needsInput.length > 0
        ? { needsInput: [...planned.needsInput] }
        : { op: { op: 'set_product_pricing', pricing: pricingSpecOf(planned) } }),
      riskNotes: [
        ...planned.warnings,
        ...(planned.kind === 'auto_renewable_subscription' && !planned.missing
          ? [
              'Play keeps existing subscribers on their current price; moving them takes an explicit price migration Agentship does not perform.',
            ]
          : []),
      ],
    });
  }

  if (planned.offersToCreate.length > 0 && !planned.missing) {
    drafts.push({
      kind: 'set_product_offers',
      target: `offers/${projection.productId}`,
      operation: 'setProductOffers',
      summary: `Add ${planned.offersToCreate.length} offer(s) to ${projection.productId}`,
      diff: planned.offersToCreate.map((offer) => ({
        path: `products.${product.id}.offers.${offer.id}`,
        after: `${offer.mode} for ${offer.periods} × ${offer.duration}`,
      })),
      dependsOn: [
        { kind: 'set_product_pricing', target: `price/${projection.productId}`, optional: true },
      ],
      op: {
        op: 'set_product_offers',
        offers: {
          productId: projection.productId,
          kind: planned.kind,
          ...(projection.group === undefined ? {} : { group: projection.group }),
          offers: planned.offersToCreate,
        },
      },
      riskNotes: ['An offer changes what eligible customers pay for their first period.'],
    });
  }

  return drafts;
}
