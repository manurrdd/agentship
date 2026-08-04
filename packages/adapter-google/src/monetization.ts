import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AdapterContext,
  AgentshipError,
  type AppRef,
  type DataSafetyDeclaration,
  ERROR_CODES,
  ensureDir,
  FILE_MODE,
  type OperationId,
  type OpResult,
  optional,
  type PriceConversion,
  type ProductKind,
  type ProductOffersSpec,
  type ProductPricingSpec,
  type ProductSpec,
  type RemoteProduct,
  type RemoteProductOffer,
  type RemoteProductPrice,
  tmpDir,
} from '@agentship/core';
import type { GoogleClient } from './client.js';
import { GOOGLE_BILLING_PERIODS, GOOGLE_PURCHASE_TYPES, gpcCommands } from './commands.js';

/**
 * Monetisation on Google Play: one-time products, subscriptions, prices and offers.
 *
 * Play's shape is the opposite of Apple's. There is no "set the price" call: a price is a
 * field of the product document, so pricing a product means writing the whole product again.
 * And a subscription is not a product with a period — it is a product containing *base
 * plans*, each with its own billing period and its own regional prices. Everything in this
 * module follows from those two facts.
 *
 * Money is written in Play's `Money` shape (`units` plus `nanos`) rather than as a float,
 * because a price is exact and a rounding error here is a real charge to a real customer.
 */
function result(
  operation: OperationId,
  fields: Partial<OpResult> & { changed: boolean; dryRun: boolean },
): OpResult {
  return { ok: true, store: 'google', operation, ...fields };
}

/** Play's `Money`: whole units plus billionths, so no price ever passes through a float. */
export interface GoogleMoney {
  readonly currencyCode: string;
  readonly units: string;
  readonly nanos: number;
}

export function toMoney(price: string, currencyCode: string): GoogleMoney {
  const [whole = '0', fraction = ''] = price.split('.');
  const nanos = Number.parseInt(fraction.padEnd(9, '0').slice(0, 9), 10);
  return { currencyCode, units: whole, nanos: Number.isNaN(nanos) ? 0 : nanos };
}

export function fromMoney(money: GoogleMoney | undefined): string | undefined {
  if (money === undefined) return undefined;
  const units = Number.parseInt(money.units, 10);
  if (Number.isNaN(units)) return undefined;
  return (units + (money.nanos ?? 0) / 1_000_000_000).toFixed(2);
}

/** Micro-units, the shape `inappproducts` uses instead of `Money`. */
function toMicros(price: string): string {
  const [whole = '0', fraction = ''] = price.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0');
  return micros.toString();
}

function fromMicros(micros: string | undefined): string | undefined {
  if (micros === undefined) return undefined;
  const value = Number.parseInt(micros, 10);
  return Number.isNaN(value) ? undefined : (value / 1_000_000).toFixed(2);
}

function isSubscription(kind: ProductKind): boolean {
  return kind === 'auto_renewable_subscription';
}

/**
 * Writes a JSON document into Agentship's private tmp tree and hands its path to `fn`.
 *
 * Every mutating `gpc` monetisation command takes `--file`, so this is the shape of every
 * write. The file lives under `AGENTSHIP_HOME` (0700), is written 0600 and is removed in a
 * `finally`, because a product document carries prices and localizations that belong to the
 * user's project rather than to the machine's shared temp directory.
 */
async function withJsonFile<T>(
  name: string,
  document: unknown,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const root = await ensureDir(join(tmpDir(), 'monetization'));
  const directory = await mkdtemp(join(root, 'm-'));
  try {
    const path = join(directory, `${name}.json`);
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: FILE_MODE });
    return await fn(path);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface PlayOneTimeProduct {
  sku?: string;
  status?: string;
  purchaseType?: string;
  defaultLanguage?: string;
  defaultPrice?: { priceMicros?: string; currency?: string };
  prices?: Record<string, { priceMicros?: string; currency?: string }>;
  listings?: Record<string, { title?: string; description?: string }>;
}

interface PlayBasePlan {
  basePlanId?: string;
  state?: string;
  autoRenewingBasePlanType?: { billingPeriodDuration?: string };
  regionalConfigs?: {
    regionCode?: string;
    newSubscriberAvailability?: boolean;
    price?: GoogleMoney;
  }[];
}

interface PlaySubscription {
  productId?: string;
  listings?: { languageCode?: string; title?: string; description?: string }[];
  basePlans?: PlayBasePlan[];
}

async function readProduct(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  productId: string,
  kind: ProductKind,
): Promise<PlayOneTimeProduct | PlaySubscription | undefined> {
  const command = isSubscription(kind)
    ? gpcCommands.subscriptionGet(ref.id, productId)
    : gpcCommands.iapGet(ref.id, productId);
  try {
    return await client.json<PlayOneTimeProduct | PlaySubscription>(context, command, {
      retryTransient: true,
    });
  } catch (error) {
    // A product Play does not have is not a failure — it is the answer the differ needs.
    if (AgentshipError.is(error) && error.code === ERROR_CODES.STORE_NOT_FOUND) return undefined;
    throw error;
  }
}

/** Everything about one product, in the neutral shape. */
export async function getGoogleProductState(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  productId: string,
  kind: ProductKind,
): Promise<RemoteProduct | undefined> {
  const raw = await readProduct(client, context, ref, productId, kind);
  if (raw === undefined) return undefined;

  if (isSubscription(kind)) {
    const subscription = raw as PlaySubscription;
    const basePlan = subscription.basePlans?.[0];
    const prices: RemoteProductPrice[] = (basePlan?.regionalConfigs ?? [])
      .map((config) => ({
        territory: config.regionCode ?? '',
        price: fromMoney(config.price) ?? '',
        ...optional('currency', config.price?.currencyCode),
      }))
      .filter((price) => price.territory !== '' && price.price !== '')
      .sort((a, b) => a.territory.localeCompare(b.territory));
    const listing = subscription.listings?.[0];
    return {
      id: subscription.productId ?? productId,
      productId,
      kind,
      ...optional('groupId', basePlan?.basePlanId),
      ...optional('displayName', listing?.title),
      ...optional('description', listing?.description),
      ...optional('period', periodOf(basePlan?.autoRenewingBasePlanType?.billingPeriodDuration)),
      ...optional('state', basePlan?.state),
      prices,
      offers: [],
    };
  }

  const product = raw as PlayOneTimeProduct;
  const listing = Object.values(product.listings ?? {})[0];
  const prices: RemoteProductPrice[] = Object.entries(product.prices ?? {})
    .map(([territory, price]) => ({
      territory,
      price: fromMicros(price.priceMicros) ?? '',
      ...optional('currency', price.currency),
    }))
    .filter((price) => price.price !== '')
    .sort((a, b) => a.territory.localeCompare(b.territory));
  const defaultPrice = fromMicros(product.defaultPrice?.priceMicros);
  return {
    id: product.sku ?? productId,
    productId,
    kind,
    ...optional('displayName', listing?.title),
    ...optional('description', listing?.description),
    ...optional('state', product.status),
    prices:
      defaultPrice === undefined || prices.some((price) => price.price === defaultPrice)
        ? prices
        : [
            ...prices,
            {
              territory: 'default',
              price: defaultPrice,
              ...optional('currency', product.defaultPrice?.currency),
            },
          ].sort((a, b) => a.territory.localeCompare(b.territory)),
  };
}

function periodOf(duration: string | undefined): string | undefined {
  if (duration === undefined) return undefined;
  const entry = Object.entries(GOOGLE_BILLING_PERIODS).find(([, value]) => value === duration);
  return entry?.[0];
}

/**
 * Builds the Play document for a product from the neutral spec plus the prices to apply.
 *
 * Kept as one function used by create *and* update, because on Play those two calls take the
 * same document: writing a product and pricing it are the same operation, and splitting them
 * in code would only invite the two paths to disagree.
 */
function documentFor(
  product: ProductSpec,
  pricing: ProductPricingSpec | undefined,
  currency: string,
): PlayOneTimeProduct | PlaySubscription {
  if (isSubscription(product.kind)) {
    const duration = GOOGLE_BILLING_PERIODS[product.period ?? ''];
    if (product.group === undefined || duration === undefined) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_INPUT_REQUIRED,
        `Subscription "${product.productId}" needs a base plan id and a billing period Play understands.`,
        { store: 'google', details: { productId: product.productId, period: product.period } },
      );
    }
    const regionalConfigs =
      pricing === undefined
        ? []
        : Object.entries({
            [pricing.baseTerritory]: pricing.basePrice,
            ...(pricing.territories ?? {}),
          })
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([regionCode, price]) => ({
              regionCode,
              newSubscriberAvailability: true,
              price: toMoney(price, currency),
            }));
    // An empty `listings` is not "no listings": Play takes the whole resource, so sending an
    // empty array would delete the store-visible names. Omitting the key lets the merge with
    // the existing document keep them.
    const listings = (product.localizations ?? []).map((localization) => ({
      languageCode: localization.locale,
      title: localization.displayName,
      ...(localization.description === undefined ? {} : { description: localization.description }),
    }));
    return {
      productId: product.productId,
      ...(listings.length === 0 ? {} : { listings }),
      basePlans: [
        {
          basePlanId: product.group,
          autoRenewingBasePlanType: { billingPeriodDuration: duration },
          regionalConfigs,
        },
      ],
    };
  }

  const purchaseType = GOOGLE_PURCHASE_TYPES[product.kind] ?? 'managedUser';
  const listings: Record<string, { title: string; description?: string }> = {};
  for (const localization of product.localizations ?? []) {
    listings[localization.locale] = {
      title: localization.displayName,
      ...(localization.description === undefined ? {} : { description: localization.description }),
    };
  }
  return {
    sku: product.productId,
    status: 'active',
    purchaseType,
    ...(product.localizations?.[0] === undefined
      ? {}
      : { defaultLanguage: product.localizations[0].locale }),
    // Same trap as the subscription listings above, and the same rule: an empty map would
    // blank the titles Play already holds, so it is left out entirely.
    ...(Object.keys(listings).length === 0 ? {} : { listings }),
    ...(pricing === undefined
      ? {}
      : {
          defaultPrice: { priceMicros: toMicros(pricing.basePrice), currency },
          prices: Object.fromEntries(
            Object.entries({
              [pricing.baseTerritory]: pricing.basePrice,
              ...(pricing.territories ?? {}),
            })
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([territory, price]) => [territory, { priceMicros: toMicros(price), currency }]),
          ),
        }),
  };
}

/**
 * Currency for a product's prices.
 *
 * Play needs one and the neutral pricing spec carries territories, not currencies, so the
 * base territory decides. The table is deliberately short: an unknown territory is an error
 * rather than a default, because guessing a currency means charging the wrong amount.
 */
const CURRENCY_BY_TERRITORY: Readonly<Record<string, string>> = {
  US: 'USD',
  GB: 'GBP',
  EU: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  JP: 'JPY',
  CA: 'CAD',
  AU: 'AUD',
  MX: 'MXN',
  BR: 'BRL',
  IN: 'INR',
};

export function currencyFor(territory: string): string {
  const currency = CURRENCY_BY_TERRITORY[territory.toUpperCase()];
  if (currency === undefined) {
    throw new AgentshipError(
      ERROR_CODES.PLAN_INPUT_REQUIRED,
      `Agentship does not know which currency Google Play prices "${territory}" in.`,
      {
        store: 'google',
        details: { territory },
        remediation: {
          summary:
            'Set monetization.products[].price.currency in the manifest, or price in a territory Agentship knows.',
        },
      },
    );
  }
  return currency;
}

export async function createGoogleProduct(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  product: ProductSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const existing = await readProduct(client, context, ref, product.productId, product.kind);
  if (existing !== undefined) {
    return result('createProduct', {
      changed: false,
      dryRun,
      details: { productId: product.productId, existed: true },
    });
  }
  if (dryRun) {
    return result('createProduct', { changed: false, dryRun, details: { would: 'create' } });
  }
  // A product is created without prices; the pricing action that follows writes them, so a
  // half-applied plan never leaves a purchasable product at a price nobody approved.
  const document = documentFor(product, undefined, 'USD');
  await withJsonFile(product.productId, document, (path) =>
    client.run(
      context,
      isSubscription(product.kind)
        ? gpcCommands.subscriptionCreate(ref.id, path)
        : gpcCommands.iapCreate(ref.id, path),
    ),
  );
  return result('createProduct', {
    changed: true,
    dryRun,
    details: { productId: product.productId },
  });
}

export async function updateGoogleProduct(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  product: ProductSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const existing = await readProduct(client, context, ref, product.productId, product.kind);
  if (existing === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_NOT_FOUND,
      `No product "${product.productId}" exists on Google Play.`,
      { store: 'google', details: { productId: product.productId } },
    );
  }
  if (dryRun) return result('updateProduct', { changed: false, dryRun });

  const document = documentFor(product, undefined, 'USD');
  await withJsonFile(product.productId, mergeExisting(existing, document), (path) =>
    client.run(
      context,
      isSubscription(product.kind)
        ? gpcCommands.subscriptionUpdate(ref.id, product.productId, path)
        : gpcCommands.iapUpdate(ref.id, product.productId, path),
    ),
  );
  return result('updateProduct', { changed: true, dryRun });
}

/**
 * Keeps the fields Agentship does not manage.
 *
 * The same trap as the Play listing: Play takes the whole resource, so sending only what the
 * manifest declares would blank everything else — a subscription's grace period, a product's
 * regional prices. The manifest's fields win; everything else survives.
 */
function mergeExisting<T extends object>(existing: T, desired: T): T {
  return { ...existing, ...desired };
}

/**
 * Applies the approved prices by rewriting the product with them.
 *
 * There is no separate pricing endpoint on Play, so this is an update that carries exactly
 * the territories the caller decided on and nothing else.
 */
export async function setGoogleProductPricing(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  pricing: ProductPricingSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const existing = await readProduct(client, context, ref, pricing.productId, pricing.kind);
  if (existing === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_NOT_FOUND,
      `No product "${pricing.productId}" to price on Google Play.`,
      { store: 'google', details: { productId: pricing.productId } },
    );
  }
  const territories = 1 + Object.keys(pricing.territories ?? {}).length;
  if (dryRun)
    return result('setProductPricing', { changed: false, dryRun, details: { territories } });

  const currency = currencyFor(pricing.baseTerritory);
  const warnings: string[] = [];
  if (pricing.preserveExistingSubscribers === true) {
    // Play migrates existing subscribers through a separate, deliberate call
    // (`subscriptions base-plans migrate-prices`), which changes what real customers are
    // charged. Agentship refuses to fold that into a price update.
    warnings.push(
      'Existing subscribers keep their current price: Play migrates them only through an explicit price migration, which Agentship does not perform.',
    );
  }

  const spec: ProductSpec = {
    productId: pricing.productId,
    kind: pricing.kind,
    referenceName: pricing.productId,
    ...optional('group', subscriptionBasePlanOf(existing)),
    ...optional('period', periodOfExisting(existing)),
  };
  const document = documentFor(spec, pricing, currency);
  await withJsonFile(pricing.productId, mergeExisting(existing, document), (path) =>
    client.run(
      context,
      isSubscription(pricing.kind)
        ? gpcCommands.subscriptionUpdate(ref.id, pricing.productId, path)
        : gpcCommands.iapUpdate(ref.id, pricing.productId, path),
    ),
  );
  return result('setProductPricing', {
    changed: true,
    dryRun,
    details: { territories, currency },
    ...(warnings.length === 0 ? {} : { warnings }),
  });
}

function subscriptionBasePlanOf(
  existing: PlayOneTimeProduct | PlaySubscription,
): string | undefined {
  return (existing as PlaySubscription).basePlans?.[0]?.basePlanId;
}

function periodOfExisting(existing: PlayOneTimeProduct | PlaySubscription): string | undefined {
  return periodOf(
    (existing as PlaySubscription).basePlans?.[0]?.autoRenewingBasePlanType?.billingPeriodDuration,
  );
}

/** Creates the subscription offers Play does not have yet. */
export async function setGoogleProductOffers(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  spec: ProductOffersSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  if (!isSubscription(spec.kind)) {
    return result('setProductOffers', {
      changed: false,
      dryRun,
      warnings: [
        'Play attaches offers to a subscription base plan; a one-time product has purchase options instead, which Agentship does not manage.',
      ],
    });
  }
  const basePlan = spec.group;
  if (basePlan === undefined) {
    throw new AgentshipError(
      ERROR_CODES.PLAN_INPUT_REQUIRED,
      `Offers for "${spec.productId}" need the base plan they belong to.`,
      { store: 'google', details: { productId: spec.productId } },
    );
  }
  const existing = await client
    .json<{ subscriptionOffers?: { offerId?: string }[] }>(
      context,
      gpcCommands.subscriptionOffersList(ref.id, spec.productId, basePlan),
      { retryTransient: true },
    )
    .catch(() => ({ subscriptionOffers: [] }));
  const have = new Set((existing.subscriptionOffers ?? []).map((offer) => offer.offerId));
  const missing = spec.offers.filter((offer) => !have.has(offer.id));
  if (missing.length === 0 || dryRun) {
    return result('setProductOffers', { changed: false, dryRun });
  }

  for (const offer of missing) {
    const duration = GOOGLE_BILLING_PERIODS[offer.duration];
    if (duration === undefined) {
      throw new AgentshipError(
        ERROR_CODES.PLAN_INPUT_REQUIRED,
        `Offer "${offer.id}" uses a duration Google Play does not express.`,
        { store: 'google', details: { offerId: offer.id, duration: offer.duration } },
      );
    }
    const document = {
      productId: spec.productId,
      basePlanId: basePlan,
      offerId: offer.id,
      phases: [
        {
          duration,
          recurrenceCount: offer.periods,
          ...(offer.mode === 'free_trial'
            ? { freePriceOverride: {} }
            : { absoluteDiscount: { currencyCode: 'USD', units: '0', nanos: 0 } }),
        },
      ],
      targeting: {},
    };
    await withJsonFile(`${spec.productId}-${offer.id}`, document, (path) =>
      client.run(context, gpcCommands.subscriptionOfferCreate(ref.id, path)),
    );
  }
  return result('setProductOffers', {
    changed: true,
    dryRun,
    details: { created: missing.length },
  });
}

/** Play's own regional conversion table, as a proposal to put in a diff. */
export async function convertGooglePrice(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  basePrice: string,
  baseTerritory: string,
): Promise<PriceConversion> {
  let currency: string;
  try {
    currency = currencyFor(baseTerritory);
  } catch {
    return { baseTerritory, basePrice, prices: [], unavailable: true };
  }
  const converted = await client
    .json<{ convertedRegionPrices?: Record<string, { price?: GoogleMoney }> }>(
      context,
      gpcCommands.pricingConvert(ref.id, currency, basePrice),
      { retryTransient: true },
    )
    .catch(() => undefined);
  const prices = Object.entries(converted?.convertedRegionPrices ?? {})
    .map(([territory, entry]) => ({
      territory,
      price: fromMoney(entry.price) ?? '',
      ...optional('currency', entry.price?.currencyCode),
    }))
    .filter((entry) => entry.price !== '')
    .sort((a, b) => a.territory.localeCompare(b.territory));
  if (prices.length === 0) return { baseTerritory, basePrice, prices: [], unavailable: true };
  return { baseTerritory, basePrice, prices };
}

/**
 * Applies the Data Safety declaration.
 *
 * The CSV arrives already generated and already approved; this only hands it over. There is
 * no read-back to compare against — Play has no GET for the declaration — so the caller
 * archives what it applied and diffs against that.
 */
export async function setGoogleDataSafety(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
  declaration: DataSafetyDeclaration,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  if (dryRun) {
    return result('dataSafety', {
      changed: false,
      dryRun,
      details: { declaredTypes: declaration.summary.length },
    });
  }
  const root = await ensureDir(join(tmpDir(), 'data-safety'));
  const directory = await mkdtemp(join(root, 'ds-'));
  try {
    const path = join(directory, 'data-safety.csv');
    await writeFile(path, declaration.csv, { mode: FILE_MODE });
    await client.run(context, gpcCommands.dataSafetyUpdate(ref.id, path));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  // The applied copy is archived by the kernel, not here: with no GET endpoint it is the
  // only thing a later plan can compare against, so it has to be produced identically by
  // every adapter — including the mock the end-to-end tests run against.
  return result('dataSafety', {
    changed: true,
    dryRun,
    details: { declaredTypes: declaration.summary.length },
    warnings: [
      'Play exposes no way to read the Data Safety declaration back, so Agentship compares against the copy it archived rather than against the store.',
    ],
  });
}

/** Offers are read per base plan; exported for the differ's convergence check. */
export type { RemoteProductOffer };
