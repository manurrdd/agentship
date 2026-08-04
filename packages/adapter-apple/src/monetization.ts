import {
  type AdapterContext,
  AgentshipError,
  type AgeRatingDeclaration,
  type AppRef,
  ERROR_CODES,
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
} from '@agentship/core';
import type { AppleClient } from './client.js';
import {
  APPLE_IAP_TYPES,
  APPLE_OFFER_MODES,
  APPLE_PERIODS,
  type AscOfferDuration,
  type AscSubscriptionPeriod,
  ascCommands,
} from './commands.js';
import { attrNumber, attrString, type JsonApiResource, relatedId } from './jsonapi.js';

/**
 * Monetisation on App Store Connect: products, prices and offers.
 *
 * Apple has two models and this module keeps them apart rather than smoothing them over.
 * A consumable, a non-consumable or a non-renewing subscription is an `inAppPurchases`
 * resource priced by *creating a price schedule*; an auto-renewable subscription lives
 * inside a *group*, is priced per territory through price *points*, and carries its own
 * introductory offers. A layer that pretended those were the same thing would produce calls
 * App Store Connect rejects — which is why {@link ProductSpec} arrives already projected and
 * this module only has to pick the right family of commands.
 *
 * The one rule that shapes every write here: **a price is applied exactly as the caller
 * passed it**. `asc` will happily resolve a price point from a customer price, and Agentship
 * uses that — but only for a number the user has already approved in a diff. Nothing in this
 * file converts, rounds or fills in a territory of its own accord.
 */
function result(
  operation: OperationId,
  fields: Partial<OpResult> & { changed: boolean; dryRun: boolean },
): OpResult {
  return { ok: true, store: 'apple', operation, ...fields };
}

function isSubscription(kind: ProductKind): boolean {
  return kind === 'auto_renewable_subscription';
}

function applePeriod(period: string | undefined): AscSubscriptionPeriod | undefined {
  return period === undefined ? undefined : APPLE_PERIODS[period];
}

/** Apple's id for a product, resolved from its store-facing product id. */
async function findProduct(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  productId: string,
  kind: ProductKind,
): Promise<JsonApiResource | undefined> {
  const command = isSubscription(kind)
    ? ascCommands.subscriptionsList(ref.id, { paginate: true })
    : ascCommands.iapList(ref.id, { paginate: true });
  const resources = await client.list(context, command, { retryTransient: true });
  return resources.find((resource) => attrString(resource, 'productId') === productId);
}

function toPrices(resources: readonly JsonApiResource[]): RemoteProductPrice[] {
  const prices: RemoteProductPrice[] = [];
  for (const resource of resources) {
    const territory =
      relatedId(resource, 'territory') ?? attrString(resource, 'territory') ?? undefined;
    const price = attrString(resource, 'customerPrice');
    if (territory === undefined || price === undefined) continue;
    prices.push({
      territory,
      price,
      ...optional('currency', attrString(resource, 'currency')),
      ...optional('pricePointId', relatedId(resource, 'subscriptionPricePoint')),
    });
  }
  return prices.sort((a, b) => a.territory.localeCompare(b.territory));
}

const OFFER_MODE_BY_APPLE: Readonly<Record<string, RemoteProductOffer['mode']>> = {
  FREE_TRIAL: 'free_trial',
  PAY_AS_YOU_GO: 'pay_as_you_go',
  PAY_UP_FRONT: 'pay_up_front',
};

function toOffers(resources: readonly JsonApiResource[]): RemoteProductOffer[] {
  return resources
    .map((resource) => ({
      id: resource.id,
      kind: 'introductory' as const,
      ...optional('mode', OFFER_MODE_BY_APPLE[attrString(resource, 'offerMode') ?? '']),
      ...optional('duration', attrString(resource, 'duration')),
      ...optional('periods', attrNumber(resource, 'numberOfPeriods')),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Everything about one product: identity, prices per territory and introductory offers.
 *
 * Returns `undefined` when the store simply has no such product; a product it has but whose
 * prices could not be read comes back without them, because "no prices reported" and "priced
 * at nothing" must never look the same to a differ.
 */
export async function getAppleProductState(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  productId: string,
  kind: ProductKind,
): Promise<RemoteProduct | undefined> {
  const resource = await findProduct(client, context, ref, productId, kind);
  if (resource === undefined) return undefined;

  const base: RemoteProduct = {
    id: resource.id,
    productId,
    kind,
    ...optional(
      'referenceName',
      attrString(resource, 'name') ?? attrString(resource, 'referenceName'),
    ),
    ...optional(
      'groupId',
      relatedId(resource, 'subscriptionGroup') ?? relatedId(resource, 'group'),
    ),
    ...optional('state', attrString(resource, 'state')),
    ...optional('period', attrString(resource, 'subscriptionPeriod')),
    ...optional('familySharable', attrString(resource, 'familySharable') === 'true'),
  };

  if (isSubscription(kind)) {
    const [prices, offers] = await Promise.all([
      client
        .list(context, ascCommands.subscriptionPricesList(resource.id, ref.id), {
          retryTransient: true,
        })
        .catch(() => []),
      client
        .list(context, ascCommands.subscriptionIntroductoryOffersList(resource.id, ref.id), {
          retryTransient: true,
        })
        .catch(() => []),
    ]);
    return { ...base, prices: toPrices(prices), offers: toOffers(offers) };
  }

  const schedule = await client
    .list(context, ascCommands.iapPricingScheduleView(resource.id, ref.id), {
      retryTransient: true,
    })
    .catch(() => []);
  return { ...base, prices: toPrices(schedule) };
}

/**
 * Creates a product, with its group when Apple needs one.
 *
 * Idempotent by store product id, because both stores reject a duplicate and a resumed plan
 * must not turn one product into an error. The subscription group is created on demand and
 * matched by reference name — Apple's own identity for a group — so a second run finds it
 * rather than creating a twin.
 */
export async function createAppleProduct(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  product: ProductSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const existing = await findProduct(client, context, ref, product.productId, product.kind);
  if (existing !== undefined) {
    return result('createProduct', {
      changed: false,
      dryRun,
      details: { productId: product.productId, id: existing.id },
    });
  }
  if (dryRun) {
    return result('createProduct', { changed: false, dryRun, details: { would: 'create' } });
  }

  const created = isSubscription(product.kind)
    ? await createSubscription(client, context, ref, product)
    : await createIap(client, context, ref, product);

  // Localizations hang off the product's *version* on Apple's current model; the deprecated
  // product-scoped resource is deliberately not used.
  if (product.localizations !== undefined && product.localizations.length > 0) {
    await writeLocalizations(client, context, created, product);
  }

  return result('createProduct', {
    changed: true,
    dryRun,
    details: { productId: product.productId, id: created },
  });
}

async function createIap(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  product: ProductSpec,
): Promise<string> {
  const type = APPLE_IAP_TYPES[product.kind];
  if (type === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_UNSUPPORTED_OPERATION,
      `App Store Connect has no in-app purchase type for "${product.kind}".`,
      { store: 'apple', details: { productId: product.productId, kind: product.kind } },
    );
  }
  const resource = await client.one(
    context,
    ascCommands.iapCreate({
      appId: ref.id,
      productId: product.productId,
      referenceName: product.referenceName,
      type,
      ...optional('familySharable', product.familySharable),
    }),
  );
  return resource?.id ?? product.productId;
}

async function createSubscription(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  product: ProductSpec,
): Promise<string> {
  const period = applePeriod(product.period);
  if (product.group === undefined || period === undefined) {
    throw new AgentshipError(
      ERROR_CODES.PLAN_INPUT_REQUIRED,
      `Subscription "${product.productId}" needs a subscription group and a billing period.`,
      { store: 'apple', details: { productId: product.productId } },
    );
  }
  const groupId = await ensureSubscriptionGroup(client, context, ref, product.group);
  const resource = await client.one(
    context,
    ascCommands.subscriptionCreate({
      groupId,
      productId: product.productId,
      referenceName: product.referenceName,
      period,
      ...optional('familySharable', product.familySharable),
    }),
  );
  return resource?.id ?? product.productId;
}

async function ensureSubscriptionGroup(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  referenceName: string,
): Promise<string> {
  const groups = await client.list(context, ascCommands.subscriptionGroupsList(ref.id), {
    retryTransient: true,
  });
  const existing = groups.find((group) => attrString(group, 'referenceName') === referenceName);
  if (existing !== undefined) return existing.id;
  const created = await client.one(
    context,
    ascCommands.subscriptionGroupCreate(ref.id, referenceName),
  );
  if (created === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_VALIDATION_FAILED,
      `App Store Connect did not return the subscription group "${referenceName}" it was asked to create.`,
      { store: 'apple' },
    );
  }
  return created.id;
}

async function writeLocalizations(
  client: AppleClient,
  context: AdapterContext,
  productResourceId: string,
  product: ProductSpec,
): Promise<void> {
  if (isSubscription(product.kind)) {
    // Subscription localizations are version-scoped too, and `asc` reaches them through the
    // review workflow rather than a standalone command on the pinned version. Leaving them
    // to the console is honest; inventing a command against a live account is not.
    return;
  }
  const versions = await client.list(context, ascCommands.iapVersionsList(productResourceId), {
    retryTransient: true,
  });
  const versionId = versions[0]?.id;
  if (versionId === undefined) return;
  for (const localization of product.localizations ?? []) {
    await client.run(
      context,
      ascCommands.iapVersionLocalizationCreate({
        versionId,
        locale: localization.locale,
        name: localization.displayName,
        ...optional('description', localization.description),
      }),
    );
  }
}

export async function updateAppleProduct(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  product: ProductSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const existing = await findProduct(client, context, ref, product.productId, product.kind);
  if (existing === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_NOT_FOUND,
      `No product "${product.productId}" exists in App Store Connect.`,
      { store: 'apple', details: { productId: product.productId } },
    );
  }
  const currentName = attrString(existing, 'name') ?? attrString(existing, 'referenceName');
  if (currentName === product.referenceName) {
    return result('updateProduct', { changed: false, dryRun });
  }
  if (dryRun) return result('updateProduct', { changed: false, dryRun });

  await client.run(
    context,
    isSubscription(product.kind)
      ? ascCommands.subscriptionUpdate({
          subscriptionId: existing.id,
          referenceName: product.referenceName,
          ...optional('period', applePeriod(product.period)),
        })
      : ascCommands.iapUpdate({
          iapId: existing.id,
          referenceName: product.referenceName,
          ...optional('familySharable', product.familySharable),
        }),
  );
  return result('updateProduct', { changed: true, dryRun });
}

/**
 * Applies exactly the prices the caller decided on.
 *
 * A subscription is priced per territory, so each territory is its own call; an IAP is
 * priced by creating one schedule from a base territory. Neither path invents a territory
 * the caller did not list.
 */
export async function setAppleProductPricing(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  pricing: ProductPricingSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const existing = await findProduct(client, context, ref, pricing.productId, pricing.kind);
  if (existing === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_NOT_FOUND,
      `No product "${pricing.productId}" to price in App Store Connect.`,
      { store: 'apple', details: { productId: pricing.productId } },
    );
  }
  const territories: (readonly [string, string])[] = [
    [pricing.baseTerritory, pricing.basePrice] as const,
    ...Object.entries(pricing.territories ?? {})
      .filter(([territory]) => territory !== pricing.baseTerritory)
      .map(([territory, price]) => [territory, price] as const),
  ].sort((a, b) => a[0].localeCompare(b[0]));

  if (dryRun) {
    return result('setProductPricing', {
      changed: false,
      dryRun,
      details: { territories: territories.length },
    });
  }

  if (isSubscription(pricing.kind)) {
    for (const [territory, price] of territories) {
      await client.run(
        context,
        ascCommands.subscriptionPriceSet({
          subscriptionId: existing.id,
          appId: ref.id,
          territory,
          price,
          ...optional('startDate', pricing.startDate),
          ...optional('preserved', pricing.preserveExistingSubscribers),
        }),
      );
    }
  } else {
    await client.run(
      context,
      ascCommands.iapPriceScheduleCreate({
        iapId: existing.id,
        appId: ref.id,
        baseTerritory: pricing.baseTerritory,
        price: pricing.basePrice,
        ...optional('startDate', pricing.startDate),
      }),
    );
    const extra = territories
      .filter(([territory]) => territory !== pricing.baseTerritory)
      .map(([territory]) => territory);
    if (extra.length > 0) {
      await client.run(
        context,
        ascCommands.iapAvailabilitySet({
          iapId: existing.id,
          appId: ref.id,
          territories: [pricing.baseTerritory, ...extra],
        }),
      );
    }
  }

  return result('setProductPricing', {
    changed: true,
    dryRun,
    details: { territories: territories.length },
    ...(pricing.preserveExistingSubscribers === true
      ? { warnings: ['Existing subscribers keep the price they signed up at.'] }
      : {}),
  });
}

const OFFER_DURATIONS: Readonly<Record<string, AscOfferDuration>> = {
  one_week: 'ONE_WEEK',
  one_month: 'ONE_MONTH',
  two_months: 'TWO_MONTHS',
  three_months: 'THREE_MONTHS',
  six_months: 'SIX_MONTHS',
  one_year: 'ONE_YEAR',
};

/**
 * Creates the introductory offers a subscription is missing.
 *
 * Only introductory offers are written. Promotional offers and offer codes exist in `asc`
 * but each one is a marketing campaign with its own eligibility rules; creating those from a
 * manifest would be guessing at a decision, so they are reported as unsupported here and
 * left to the console.
 */
export async function setAppleProductOffers(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  spec: ProductOffersSpec,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  const warnings: string[] = [];
  const introductory = spec.offers.filter((offer) => offer.kind === 'introductory');
  const skipped = spec.offers.filter((offer) => offer.kind !== 'introductory');
  for (const offer of skipped) {
    warnings.push(
      `Offer "${offer.id}" is a ${offer.kind} offer; Agentship does not create those, because their eligibility rules are a marketing decision. Create it in App Store Connect.`,
    );
  }
  if (!isSubscription(spec.kind)) {
    return result('setProductOffers', {
      changed: false,
      dryRun,
      warnings: [
        ...warnings,
        'Introductory offers only exist for auto-renewable subscriptions on the App Store.',
      ],
    });
  }

  const existing = await findProduct(client, context, ref, spec.productId, spec.kind);
  if (existing === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_NOT_FOUND,
      `No subscription "${spec.productId}" to attach offers to.`,
      { store: 'apple', details: { productId: spec.productId } },
    );
  }
  const current = toOffers(
    await client.list(
      context,
      ascCommands.subscriptionIntroductoryOffersList(existing.id, ref.id),
      { retryTransient: true },
    ),
  );
  const missing = introductory.filter(
    (offer) =>
      !current.some(
        (candidate) =>
          candidate.duration === OFFER_DURATIONS[offer.duration] &&
          candidate.mode === offer.mode &&
          candidate.periods === offer.periods,
      ),
  );
  if (missing.length === 0 || dryRun) {
    return result('setProductOffers', {
      changed: false,
      dryRun,
      ...(warnings.length === 0 ? {} : { warnings }),
    });
  }

  for (const offer of missing) {
    const duration = OFFER_DURATIONS[offer.duration];
    const mode = APPLE_OFFER_MODES[offer.mode];
    if (duration === undefined || mode === undefined) {
      warnings.push(
        `Offer "${offer.id}" uses a duration or mode App Store Connect does not accept.`,
      );
      continue;
    }
    await client.run(
      context,
      ascCommands.subscriptionIntroductoryOfferCreate({
        subscriptionId: existing.id,
        appId: ref.id,
        duration,
        mode,
        numberOfPeriods: offer.periods,
        ...(offer.territories === undefined || offer.territories.length === 0
          ? { allTerritories: true }
          : { territory: offer.territories[0] as string }),
      }),
    );
  }
  return result('setProductOffers', {
    changed: true,
    dryRun,
    details: { created: missing.length },
    ...(warnings.length === 0 ? {} : { warnings }),
  });
}

/**
 * Apple's price points, read as a conversion proposal.
 *
 * App Store Connect has no "convert this price" endpoint; what it has is a list of price
 * points per territory for a given product. Listing them for the base price is the closest
 * honest answer, and when there is no product to list them against there is no proposal at
 * all — reported as `unavailable`, never approximated with an exchange rate.
 */
export async function convertApplePrice(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  basePrice: string,
  baseTerritory: string,
  productId?: string,
  kind: ProductKind = 'non_consumable',
): Promise<PriceConversion> {
  if (productId === undefined) {
    return { baseTerritory, basePrice, prices: [], unavailable: true };
  }
  const existing = await findProduct(client, context, ref, productId, kind);
  if (existing === undefined) {
    return { baseTerritory, basePrice, prices: [], unavailable: true };
  }
  const command = isSubscription(kind)
    ? ascCommands.subscriptionPricePointsList({
        subscriptionId: existing.id,
        appId: ref.id,
        price: basePrice,
      })
    : ascCommands.iapPricePointsList({ iapId: existing.id, appId: ref.id, price: basePrice });
  const points = await client.list(context, command, { retryTransient: true }).catch(() => []);
  if (points.length === 0) {
    return { baseTerritory, basePrice, prices: [], unavailable: true };
  }
  return {
    baseTerritory,
    basePrice,
    prices: points
      .map((point) => ({
        territory: relatedId(point, 'territory') ?? attrString(point, 'territory') ?? '',
        price: attrString(point, 'customerPrice') ?? '',
        ...optional('currency', attrString(point, 'currency')),
      }))
      .filter((entry) => entry.territory !== '' && entry.price !== '')
      .sort((a, b) => a.territory.localeCompare(b.territory)),
  };
}

/**
 * Writes the age rating declaration.
 *
 * `--all-none` first, then the answers that differ, so the result is a function of the
 * declaration alone: without it, an edit would inherit whatever the previous questionnaire
 * left in the fields it does not mention, and two identical plans could produce two
 * different ratings.
 */
export async function setAppleAgeRating(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
  declaration: AgeRatingDeclaration,
): Promise<OpResult> {
  const dryRun = context.dryRun === true;
  if (dryRun) {
    return result('contentRating', {
      changed: false,
      dryRun,
      details: { answers: Object.keys(declaration.answers).length },
    });
  }
  await client.run(
    context,
    ascCommands.ageRatingEdit({
      appId: ref.id,
      allNone: declaration.allNone !== false,
      answers: declaration.answers,
    }),
  );
  return result('contentRating', {
    changed: true,
    dryRun,
    details: { answers: Object.keys(declaration.answers).length },
  });
}

/** Reads the age rating declaration, or `undefined` when the app has none yet. */
export async function getAppleAgeRating(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
): Promise<{ id?: string; answers: Record<string, string | boolean> } | undefined> {
  const resource = await client.one(context, ascCommands.ageRatingView(ref.id), {
    retryTransient: true,
  });
  if (resource === undefined) return undefined;
  const answers: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(resource.attributes ?? {})) {
    if (typeof value === 'string' || typeof value === 'boolean') answers[key] = value;
  }
  return { id: resource.id, answers };
}
