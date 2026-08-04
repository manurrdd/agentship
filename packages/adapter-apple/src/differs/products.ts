import type { ActionDraft, DifferInput, PlannedProduct, ResourceDiffer } from '@agentship/core';
import { planProducts, pricingSpecOf, productSpecOf } from '@agentship/core';

/**
 * `apple/products` — in-app purchases, subscriptions, their prices and their offers.
 *
 * Three actions per product rather than one, because they are three different decisions and
 * each is approved on its own: creating a purchasable product, setting what customers pay,
 * and adding an introductory offer. Splitting them also means a half-applied plan never
 * leaves a product priced at something nobody approved — the create lands, the pricing waits
 * for its own approval, and a product with no price cannot be submitted anyway.
 *
 * Ordering matters and is expressed the only way a differ can express it: `dependsOn`. Price
 * and offers depend on the product existing; on Apple a new IAP is also an item of the
 * review submission, so the submission depends on the pricing rather than the other way
 * round.
 */
export function appleProductsDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'products',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const plan = await planProducts(input);
      const locales = Object.keys(input.manifest.metadata.locales).sort();
      const drafts: ActionDraft[] = [];

      for (const planned of plan.products) {
        drafts.push(...draftsFor(planned, locales));
      }

      // Drift is reported through the plan's own machinery: an action that needs input, with
      // the products named. Nothing is ever removed — a product the store has and the
      // manifest does not may be one customers already own.
      if (plan.drift.length > 0) {
        drafts.push({
          kind: 'review_product_drift',
          target: 'products',
          operation: 'listProducts',
          summary: `${plan.drift.length} App Store product(s) are not declared in the manifest`,
          diff: plan.drift.map((product) => ({
            path: `products.${product.productId}`,
            before: product.kind,
            note: 'Present in App Store Connect, absent from the manifest. Agentship never deletes a product.',
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
        ? `Create ${product.type} ${projection.productId}${projection.group === undefined ? '' : ` in group ${projection.group}`}`
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
        ? [
            'A created product is not sellable until it has a price and has been submitted with a version.',
          ]
        : [],
    });
  }

  if (planned.priceDiff.length > 0) {
    const pricing = pricingSpecOf(planned);
    drafts.push({
      kind: 'set_product_pricing',
      target: `price/${projection.productId}`,
      operation: 'setProductPricing',
      summary: `Price ${projection.productId} at ${product.price.base} (${product.price.baseTerritory}) across ${Object.keys(planned.desiredPrices).length} territory/territories`,
      diff: [...planned.priceDiff],
      dependsOn: [
        { kind: 'create_product', target: `product/${projection.productId}`, optional: true },
        { kind: 'update_product', target: `product/${projection.productId}`, optional: true },
      ],
      ...(planned.needsInput.length > 0
        ? { needsInput: [...planned.needsInput] }
        : { op: { op: 'set_product_pricing', pricing } }),
      riskNotes: [
        ...planned.warnings,
        ...(pricing.preserveExistingSubscribers === true
          ? [
              'Existing subscribers keep the price they signed up at. Moving them to the new price is a separate decision Agentship does not make.',
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
      riskNotes: ['An introductory offer changes what new customers pay for their first period.'],
    });
  }

  return drafts;
}
