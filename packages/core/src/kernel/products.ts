import type { OfferSpec, ProductPricingSpec, ProductSpec } from '../store-ops.js';
import type { ProductKind, RemoteProduct } from '../store-state.js';
import { canonicalTerritory } from '../territories.js';
import type { Store } from '../types.js';
import type { DiffEntry, DifferInput } from './differ.js';
import { isNeedsInput } from './manifest.js';
import type { MonetizationProduct } from './monetization.js';
import { priceLooksSuspicious } from './monetization.js';
import { checkPriceShape, currencyOfTerritory } from './pretty-price.js';

/**
 * Turning the neutral monetisation declaration into per-store work.
 *
 * Shared by both stores' product differs because the *decisions* are the same everywhere —
 * does this product exist, has its price moved, is a price change large enough to be
 * suspicious, is a remote product undeclared — while only the projection and the command
 * vocabulary differ. Keeping the decisions in one place is what makes "never delete an
 * undeclared product" a property of the system rather than of two implementations that
 * happen to agree today.
 *
 * Three rules run through it:
 *
 * - **No price without a proposal the user can read.** A `convert` strategy asks the store
 *   for its regional table and puts every territory in the diff. When the store cannot
 *   answer, the action becomes `needs_input`; it never falls back to the base price applied
 *   everywhere.
 * - **Drift is reported, never resolved.** A product the store has and the manifest does not
 *   is someone's decision — possibly a product customers already own. It is surfaced as a
 *   warning and nothing else.
 * - **Removal is explicit and manual.** `state: absent` produces a `needs_input` action that
 *   names what would break, because deleting a product breaks every customer who bought it.
 */
export const PRODUCT_KIND_BY_TYPE: Readonly<Record<string, ProductKind>> = {
  subscription: 'auto_renewable_subscription',
  consumable: 'consumable',
  non_consumable: 'non_consumable',
  non_renewing: 'non_renewing_subscription',
};

export interface ProductProjection {
  readonly productId: string;
  /** Apple: subscription group reference name. Google: base plan id. */
  readonly group?: string;
  /** Apple only: rank inside the subscription group. */
  readonly level?: number;
}

/** The store-specific half of a product, or `undefined` when it does not target this store. */
export function projectionFor(
  product: MonetizationProduct,
  store: Store,
): ProductProjection | undefined {
  if (store === 'apple') {
    const apple = product.apple;
    if (apple === undefined) return undefined;
    return {
      productId: apple.productId,
      ...(apple.group === undefined ? {} : { group: apple.group }),
      ...(apple.level === undefined ? {} : { level: apple.level }),
    };
  }
  const google = product.google;
  if (google === undefined) return undefined;
  return {
    productId: google.productId,
    ...(google.basePlan === undefined ? {} : { group: google.basePlan }),
  };
}

export interface PlannedProduct {
  readonly product: MonetizationProduct;
  readonly projection: ProductProjection;
  readonly kind: ProductKind;
  readonly remote: RemoteProduct | undefined;
  /** The store has no such product. */
  readonly missing: boolean;
  /** Product metadata (reference name, localizations) that has to change. */
  readonly metadataDiff: readonly DiffEntry[];
  /** Prices that have to change, per territory. */
  readonly priceDiff: readonly DiffEntry[];
  /** Exactly the territories to apply, already decided. Empty means nothing to price. */
  readonly desiredPrices: Readonly<Record<string, string>>;
  readonly offersToCreate: readonly OfferSpec[];
  /** Manifest paths that stop this product being planned. */
  readonly needsInput: readonly string[];
  /** Price moves large enough that the diff should say so out loud. */
  readonly warnings: readonly string[];
  /** Removal was asked for, which Agentship never performs on its own. */
  readonly removal: boolean;
}

export interface ProductPlan {
  readonly products: readonly PlannedProduct[];
  /** Store products the manifest says nothing about. Reported; never removed. */
  readonly drift: readonly RemoteProduct[];
}

export function productSpecOf(planned: PlannedProduct, locales: readonly string[]): ProductSpec {
  const localizations = locales
    .map((locale) => {
      const entry = planned.product.names[locale];
      return entry === undefined
        ? undefined
        : {
            locale,
            displayName: entry.displayName,
            ...(entry.description === undefined ? {} : { description: entry.description }),
          };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return {
    productId: planned.projection.productId,
    kind: planned.kind,
    referenceName: planned.product.id,
    ...(planned.projection.group === undefined ? {} : { group: planned.projection.group }),
    ...(planned.projection.level === undefined ? {} : { level: planned.projection.level }),
    ...(planned.product.period === undefined ? {} : { period: planned.product.period }),
    ...(planned.product.familySharable === undefined
      ? {}
      : { familySharable: planned.product.familySharable }),
    ...(localizations.length === 0 ? {} : { localizations }),
  };
}

export function pricingSpecOf(planned: PlannedProduct): ProductPricingSpec {
  const price = planned.product.price;
  const base = canonicalTerritory(price.baseTerritory) ?? price.baseTerritory;
  const territories = Object.fromEntries(
    Object.entries(planned.desiredPrices).filter(([territory]) => territory !== base),
  );
  // Raising the price of a live subscription changes what real customers pay, so the
  // existing-subscriber decision is always made explicitly rather than by default.
  const live = planned.remote !== undefined && (planned.remote.prices ?? []).length > 0;
  return {
    productId: planned.projection.productId,
    kind: planned.kind,
    basePrice: price.base,
    baseTerritory: price.baseTerritory,
    ...(Object.keys(territories).length === 0 ? {} : { territories }),
    ...(live && planned.kind === 'auto_renewable_subscription'
      ? { preserveExistingSubscribers: true }
      : {}),
  };
}

/**
 * Works out what each declared product needs, asking the store for a price conversion when
 * the manifest asked for one.
 *
 * Async only because of that conversion; everything else is a pure comparison against the
 * snapshot, so a plan built without proposals still converges on names and on explicitly
 * listed territories.
 */
export async function planProducts(input: DifferInput): Promise<ProductPlan> {
  const monetization = input.manifest.monetization;
  // No `monetization` section at all means the user is not managing products through
  // Agentship, and reporting every product they have as drift would be noise. An *empty*
  // section is different: it says "these are my products" and lists none, so anything the
  // store holds is worth surfacing.
  if (monetization === undefined) return { products: [], drift: [] };
  const declared = new Set<string>();
  const products: PlannedProduct[] = [];

  for (const product of [...monetization.products].sort((a, b) => a.id.localeCompare(b.id))) {
    const projection = projectionFor(product, input.store);
    if (projection === undefined) continue;
    declared.add(projection.productId);

    const kind = PRODUCT_KIND_BY_TYPE[product.type] ?? 'unknown';
    const remote = input.state.products.find(
      (candidate) => candidate.productId === projection.productId,
    );
    const needsInput: string[] = [];
    const warnings: string[] = [];

    if (product.state === 'absent') {
      products.push({
        product,
        projection,
        kind,
        remote,
        missing: remote === undefined,
        metadataDiff: [],
        priceDiff: [],
        desiredPrices: {},
        offersToCreate: [],
        needsInput: [`monetization.products.${product.id}.state`],
        warnings: [
          `Removing "${projection.productId}" breaks every customer who already owns it, and neither store lets it be undone. Agentship will not delete a product: do it in the console if that is really the intent.`,
        ],
        removal: true,
      });
      continue;
    }

    const metadataDiff: DiffEntry[] = [];
    if (remote === undefined) {
      metadataDiff.push({ path: `products.${projection.productId}`, after: product.type });
    } else if (remote.referenceName !== undefined && remote.referenceName !== product.id) {
      metadataDiff.push({
        path: `products.${projection.productId}.referenceName`,
        before: remote.referenceName,
        after: product.id,
      });
    }
    for (const [locale, names] of Object.entries(product.names).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (isNeedsInput(names.displayName)) {
        needsInput.push(`monetization.products.${product.id}.names.${locale}.displayName`);
        continue;
      }
      if (remote === undefined || remote.displayName !== names.displayName) {
        metadataDiff.push({
          path: `products.${projection.productId}.names.${locale}`,
          ...(remote?.displayName === undefined ? {} : { before: remote.displayName }),
          after: names.displayName,
        });
      }
    }

    const { desiredPrices, priceDiff, priceWarnings, priceNeedsInput } = await resolvePrices(
      input,
      product,
      remote,
      monetization.priceSanityFactor,
    );
    needsInput.push(...priceNeedsInput);
    warnings.push(...priceWarnings);

    const existingOffers = new Set((remote?.offers ?? []).map((offer) => offer.id));
    const offersToCreate: OfferSpec[] = product.offers
      .filter((offer) => !existingOffers.has(offer.id))
      .map((offer) => ({
        id: offer.id,
        kind: offer.kind,
        mode: offer.mode,
        ...(offer.price === undefined ? {} : { price: offer.price }),
        duration: offer.duration,
        periods: offer.periods,
        ...(offer.territories === undefined ? {} : { territories: offer.territories }),
      }));

    products.push({
      product,
      projection,
      kind,
      remote,
      missing: remote === undefined,
      metadataDiff,
      priceDiff,
      desiredPrices,
      offersToCreate,
      needsInput,
      warnings,
      removal: false,
    });
  }

  const drift = input.state.products
    .filter((remote) => !declared.has(remote.productId))
    .sort((a, b) => a.productId.localeCompare(b.productId));

  return { products, drift };
}

interface ResolvedPrices {
  readonly desiredPrices: Readonly<Record<string, string>>;
  readonly priceDiff: readonly DiffEntry[];
  readonly priceWarnings: readonly string[];
  readonly priceNeedsInput: readonly string[];
}

async function resolvePrices(
  input: DifferInput,
  product: MonetizationProduct,
  remote: RemoteProduct | undefined,
  sanityFactor: number,
): Promise<ResolvedPrices> {
  const price = product.price;
  // Territories are keyed by country, not by the spelling the manifest happened to use:
  // Apple's codes are alpha-3 and Google's alpha-2, and the base territory is folded in
  // here, so comparing raw strings showed one country twice in the diff a human approves.
  const wanted = new Map<string, string>();
  const put = (territory: string, value: string): void => {
    wanted.set(canonicalTerritory(territory) ?? territory, value);
  };
  put(price.baseTerritory, price.base);

  const declaredTerritories = Object.keys(price.territories ?? {}).length > 0;
  // An unstated strategy is answered by the manifest itself; see the schema for why this is
  // derived rather than defaulted.
  const strategy = price.strategy ?? (declaredTerritories ? 'manual' : 'convert');

  if (strategy === 'convert') {
    const conversion = await input.proposals
      ?.convertPrice(price.base, price.baseTerritory)
      .catch(() => undefined);
    if (conversion === undefined || conversion.unavailable === true) {
      return {
        desiredPrices: {},
        priceDiff: [],
        priceWarnings: [],
        priceNeedsInput: [`monetization.products.${product.id}.price.territories`],
      };
    }
    for (const entry of conversion.prices) put(entry.territory, entry.price);
  }
  // Explicit territories always win over a conversion: a number the user wrote is a
  // decision, and the store's proposal is only a proposal.
  for (const [territory, value] of Object.entries(price.territories ?? {})) {
    put(territory, value);
  }

  const current = new Map(
    (remote?.prices ?? []).map(
      (entry) => [canonicalTerritory(entry.territory) ?? entry.territory, entry.price] as const,
    ),
  );
  const priceDiff: DiffEntry[] = [];
  const priceWarnings: string[] = [];
  // A price is quoted in its own territory's currency, so whether a number "looks like a
  // price" is a question about that currency: 199 is an ordinary rupee price and an absurd
  // euro one. Checked here, at plan time, because the alternative is Apple rejecting an
  // amount it has no price point for *after* the user approved a table of 175 numbers.
  const unconventional: string[] = [];
  for (const [territory, raw] of [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const currency = currencyOfTerritory(territory);
    const shape = currency === undefined ? undefined : checkPriceShape(raw, currency);
    let value = raw;
    if (shape !== undefined && !shape.conventional) {
      if (price.rounding === 'pretty') {
        value = shape.suggestion;
        wanted.set(territory, value);
      } else {
        unconventional.push(`${territory} ${raw} ${currency} → ${shape.suggestion}`);
      }
    }

    const before = current.get(territory);
    if (before === value) continue;
    priceDiff.push({
      path: `products.${product.id}.price.${territory}`,
      ...(before === undefined ? {} : { before }),
      after: value,
      ...(value !== raw
        ? { note: `Rounded from ${raw} to the nearest conventional ${currency} price.` }
        : territory === (canonicalTerritory(price.baseTerritory) ?? price.baseTerritory)
          ? {}
          : {
              note:
                strategy === 'convert' && price.territories?.[territory] === undefined
                  ? 'Proposed by the store’s own conversion from the base price.'
                  : 'Declared in the manifest.',
            }),
    });
    if (before !== undefined && priceLooksSuspicious(before, value, sanityFactor)) {
      priceWarnings.push(
        `${territory}: the price moves from ${before} to ${value}, more than ${sanityFactor}× in one step. Check the decimal point before approving.`,
      );
    }
  }

  if (unconventional.length > 0) {
    const shown = unconventional.slice(0, 8).join('; ');
    priceWarnings.push(
      `${unconventional.length} price(s) are not a shape stores and customers expect, and App Store Connect may have no price point for them: ${shown}${
        unconventional.length > 8 ? `; and ${unconventional.length - 8} more` : ''
      }. Set monetization.products[].price.rounding to "pretty" to adopt the suggestions, or leave them and they will be sent as written.`,
    );
  }

  return {
    desiredPrices: Object.fromEntries(wanted),
    priceDiff,
    priceWarnings,
    priceNeedsInput: [],
  };
}
