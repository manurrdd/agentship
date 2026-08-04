import {
  type AdapterContext,
  AgentshipError,
  type AppRef,
  type AppSummary,
  ERROR_CODES,
  optional,
  type RemoteAgeRating,
  type RemoteAppState,
  type RemoteBuild,
  type RemoteImage,
  type RemoteImageSet,
  type RemoteLocalization,
  type RemotePhasedRelease,
  type RemotePricing,
  type RemoteProduct,
  type RemoteTesterGroup,
  type RemoteTrackState,
  type RemoteVersion,
  type ScreenshotDevice,
  type StateGap,
} from '@agentship/core';
import { APPLE_PENDING_OPERATIONS } from './capabilities.js';
import type { AppleClient } from './client.js';
import { APPLE_DEVICE_TYPES, ascCommands } from './commands.js';
import { attrBoolean, attrNumber, attrString, type JsonApiResource, relatedId } from './jsonapi.js';
import {
  toAppPlatform,
  toAscPlatform,
  toBuildState,
  toProductKind,
  toReleaseStrategy,
  toVersionState,
  trackForBetaGroup,
} from './mapping.js';
import { getAppleAgeRating, getAppleProductState } from './monetization.js';

/** How many recent builds a snapshot carries. Enough to plan a release, bounded on purpose. */
const BUILD_LIMIT = 25;
/** How many locales of the target version have their screenshots enumerated. */
const SCREENSHOT_LOCALE_LIMIT = 40;

/**
 * Assembling the snapshot.
 *
 * Only the app lookup is allowed to fail the whole call: without it there is no app to
 * describe. Every other section is collected inside {@link section}, so a missing role, a
 * disabled feature or a transient failure narrows the snapshot and records a
 * {@link StateGap} instead of destroying it. That distinction matters upstream: the kernel
 * must be able to tell "this app has no in-app purchases" from "Agentship could not find
 * out", and only the first is safe to plan against.
 */
async function section<T>(
  gaps: StateGap[],
  area: string,
  fallback: T,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const agentship = AgentshipError.is(error) ? error : undefined;
    gaps.push({
      area,
      reason: agentship?.message ?? String(error),
      kind: gapKind(agentship?.code),
      ...optional(
        'pendingId',
        agentship?.code === ERROR_CODES.AUTH_PERMISSION_DENIED
          ? 'apple:agreements-tax-banking'
          : undefined,
      ),
    });
    return fallback;
  }
}

function gapKind(code: string | undefined): StateGap['kind'] {
  switch (code) {
    case ERROR_CODES.AUTH_PERMISSION_DENIED:
    case ERROR_CODES.STORE_UNAUTHORIZED:
      return 'forbidden';
    case ERROR_CODES.STORE_NOT_FOUND:
      return 'not_found';
    case ERROR_CODES.STORE_UNSUPPORTED_OPERATION:
      return 'no_api';
    default:
      return 'error';
  }
}

export async function getAppleAppState(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
): Promise<RemoteAppState> {
  const gaps: StateGap[] = [];
  const platform = toAscPlatform(ref.platform);

  const appResource = await client.one(context, ascCommands.appView(ref.id));
  if (appResource === undefined) {
    throw new AgentshipError(
      ERROR_CODES.STORE_NOT_FOUND,
      `App Store Connect has no app with id ${ref.id}.`,
      {
        store: 'apple',
        details: { appId: ref.id },
        remediation: {
          summary:
            'Check the app id, or create the app record in App Store Connect if it does not exist yet.',
        },
      },
    );
  }

  const app = toAppSummary(ref, appResource);
  const versions = await section(gaps, 'versions', [] as RemoteVersion[], async () =>
    (await client.list(context, ascCommands.versionsList(ref.id, { platform, limit: 20 }))).map(
      toRemoteVersion,
    ),
  );

  // Metadata edits and screenshots always target the newest editable version; when there is
  // none, the newest version overall still describes what the store shows today.
  const target = pickTargetVersion(versions);

  const [appInfoLocalizations, versionLocalizations] = await Promise.all([
    section(gaps, 'localizations.appInfo', [] as JsonApiResource[], () =>
      client.list(context, ascCommands.localizationsList({ appId: ref.id }, { paginate: true })),
    ),
    target === undefined
      ? Promise.resolve([])
      : section(gaps, 'localizations.version', [] as JsonApiResource[], () =>
          client.list(
            context,
            ascCommands.localizationsList({ versionId: target.id }, { paginate: true }),
          ),
        ),
  ]);

  const localizations = mergeLocalizations(appInfoLocalizations, versionLocalizations, target?.id);

  const images =
    target === undefined
      ? []
      : await section(gaps, 'images', [] as RemoteImageSet[], () =>
          loadScreenshots(client, context, versionLocalizations),
        );

  const builds = await section(gaps, 'builds', [] as RemoteBuild[], async () =>
    (
      await client.list(context, ascCommands.buildsList(ref.id, { platform, limit: BUILD_LIMIT }))
    ).map(toRemoteBuild),
  );

  const testerGroups = await section(gaps, 'testerGroups', [] as RemoteTesterGroup[], async () =>
    (await client.list(context, ascCommands.testflightGroupsList(ref.id, { paginate: true }))).map(
      toTesterGroup,
    ),
  );

  const pricing = await section(gaps, 'pricing', undefined as RemotePricing | undefined, () =>
    loadPricing(client, context, ref.id),
  );

  const products = await section(gaps, 'products', [] as RemoteProduct[], () =>
    loadProducts(client, context, ref),
  );

  const phasedRelease =
    target === undefined
      ? undefined
      : await section(gaps, 'phasedRelease', undefined as RemotePhasedRelease | undefined, () =>
          loadPhasedRelease(client, context, target.id),
        );

  // Unlike App Privacy, the age rating declaration *is* in the public API, so the snapshot
  // can answer whether it has been filled in rather than guessing.
  const ageRating = await section(gaps, 'ageRating', undefined as RemoteAgeRating | undefined, () =>
    getAppleAgeRating(client, context, ref),
  );

  return {
    store: 'apple',
    ref,
    capturedAt: new Date().toISOString(),
    app,
    versions,
    localizations,
    images,
    builds,
    testerGroups,
    // Apple has no track resource: the App Store is the only "track", and everything else
    // is TestFlight, which this snapshot expresses through `testerGroups`.
    tracks: toProductionTrack(versions),
    ...(pricing === undefined ? {} : { pricing }),
    products,
    ...(phasedRelease === undefined ? {} : { phasedRelease }),
    ...(ageRating === undefined ? {} : { ageRating }),
    gaps,
    pending: APPLE_PENDING_OPERATIONS,
  };
}

/** The version an edit would land on: the newest editable one, else the newest overall. */
export function pickTargetVersion(versions: readonly RemoteVersion[]): RemoteVersion | undefined {
  return versions.find((v) => v.state === 'draft' || v.state === 'rejected') ?? versions[0];
}

export function toAppSummary(ref: AppRef, resource: JsonApiResource): AppSummary {
  const bundleId = attrString(resource, 'bundleId');
  const platform = ref.platform ?? toAppPlatform(attrString(resource, 'platform'));
  return {
    ref: { ...ref, ...optional('bundleId', bundleId), ...optional('platform', platform) },
    name: attrString(resource, 'name') ?? ref.id,
    ...optional('bundleId', bundleId),
    ...optional('sku', attrString(resource, 'sku')),
    ...optional('primaryLocale', attrString(resource, 'primaryLocale')),
    platforms: platform === undefined ? [] : [platform],
  };
}

function toRemoteVersion(resource: JsonApiResource): RemoteVersion {
  const rawState = attrString(resource, 'appStoreState') ?? attrString(resource, 'appVersionState');
  return {
    id: resource.id,
    version: attrString(resource, 'versionString') ?? '',
    state: toVersionState(rawState),
    ...optional('platform', toAppPlatform(attrString(resource, 'platform'))),
    ...optional('releaseStrategy', toReleaseStrategy(attrString(resource, 'releaseType'))),
    ...optional('createdAt', attrString(resource, 'createdDate')),
    ...optional('buildId', relatedId(resource, 'build')),
    ...optional('copyright', attrString(resource, 'copyright')),
    ...optional('rawState', rawState),
  };
}

function mergeLocalizations(
  appInfo: readonly JsonApiResource[],
  versionScoped: readonly JsonApiResource[],
  versionId: string | undefined,
): RemoteLocalization[] {
  const byLocale = new Map<string, RemoteLocalization>();

  for (const resource of appInfo) {
    const locale = attrString(resource, 'locale');
    if (locale === undefined) continue;
    byLocale.set(locale, {
      locale,
      id: resource.id,
      ...optional('name', attrString(resource, 'name')),
      ...optional('subtitle', attrString(resource, 'subtitle')),
      ...optional('privacyPolicyUrl', attrString(resource, 'privacyPolicyUrl')),
    });
  }

  for (const resource of versionScoped) {
    const locale = attrString(resource, 'locale');
    if (locale === undefined) continue;
    const existing = byLocale.get(locale) ?? { locale };
    byLocale.set(locale, {
      ...existing,
      // The version localization is the one metadata writes address, so its id wins.
      id: resource.id,
      ...optional('versionId', versionId),
      ...optional('description', attrString(resource, 'description')),
      ...optional('keywords', attrString(resource, 'keywords')),
      ...optional('whatsNew', attrString(resource, 'whatsNew')),
      ...optional('promotionalText', attrString(resource, 'promotionalText')),
      ...optional('marketingUrl', attrString(resource, 'marketingUrl')),
      ...optional('supportUrl', attrString(resource, 'supportUrl')),
    });
  }

  return [...byLocale.values()].sort((a, b) => a.locale.localeCompare(b.locale));
}

/** Reverse of {@link APPLE_DEVICE_TYPES}: Apple display size to the neutral device family. */
const DEVICE_BY_APPLE_TYPE = new Map<string, ScreenshotDevice>(
  Object.entries(APPLE_DEVICE_TYPES)
    .filter((entry): entry is [ScreenshotDevice, string] => entry[1] !== undefined)
    .map(([device, appleType]) => [appleType, device]),
);

async function loadScreenshots(
  client: AppleClient,
  context: AdapterContext,
  versionLocalizations: readonly JsonApiResource[],
): Promise<RemoteImageSet[]> {
  const sets: RemoteImageSet[] = [];
  for (const localization of versionLocalizations.slice(0, SCREENSHOT_LOCALE_LIMIT)) {
    const locale = attrString(localization, 'locale');
    if (locale === undefined) continue;
    const document = await client.list(context, ascCommands.screenshotsList(localization.id));
    for (const setResource of document) {
      const appleType = attrString(setResource, 'screenshotDisplayType');
      const device = appleType === undefined ? undefined : DEVICE_BY_APPLE_TYPE.get(appleType);
      // A display size Agentship does not target is still reported, so the user can see it.
      sets.push({
        locale,
        device: device ?? 'phone',
        slot: 'screenshots',
        id: setResource.id,
        images: toImages(setResource),
      });
    }
  }
  return sets;
}

/**
 * Screenshot sets carry their images either sideloaded or as a nested attribute depending
 * on the endpoint; both shapes are read, and an unreadable one yields an empty set rather
 * than an error, because "no screenshots" and "unknown screenshots" are distinguished by
 * the gap list, not by throwing here.
 */
function toImages(setResource: JsonApiResource): RemoteImage[] {
  const nested = setResource.attributes?.['screenshots'];
  if (!Array.isArray(nested)) return [];
  const images: RemoteImage[] = [];
  for (const entry of nested) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : undefined;
    if (id === undefined) continue;
    const attributes = (record['attributes'] ?? record) as Record<string, unknown>;
    images.push({
      id,
      ...(typeof attributes['sourceFileChecksum'] === 'string'
        ? { md5: attributes['sourceFileChecksum'] }
        : {}),
      ...(typeof attributes['fileName'] === 'string' ? { fileName: attributes['fileName'] } : {}),
    });
  }
  return images;
}

export function toRemoteBuild(resource: JsonApiResource): RemoteBuild {
  const expired = attrBoolean(resource, 'expired');
  return {
    id: resource.id,
    buildNumber: attrString(resource, 'version') ?? '',
    ...optional('version', attrString(resource, 'preReleaseVersion')),
    state: toBuildState(attrString(resource, 'processingState'), expired),
    ...optional('platform', toAppPlatform(attrString(resource, 'platform'))),
    ...optional('uploadedAt', attrString(resource, 'uploadedDate')),
    ...optional('expired', expired),
  };
}

function toTesterGroup(resource: JsonApiResource): RemoteTesterGroup {
  const publicLink = attrString(resource, 'publicLink');
  return {
    id: resource.id,
    name: attrString(resource, 'name') ?? resource.id,
    track: trackForBetaGroup({
      ...optional('isInternal', attrBoolean(resource, 'isInternalGroup')),
      hasPublicLink: publicLink !== undefined,
    }),
    kind: 'individuals',
    // Membership is not sideloaded by `groups list`; it is fetched on demand by the
    // operations that need it, so the snapshot stays one call per section.
    members: [],
    ...optional('publicLink', publicLink),
  };
}

/** Apple's only real track is the App Store, described by the newest published version. */
function toProductionTrack(versions: readonly RemoteVersion[]): RemoteTrackState[] {
  const published = versions.find(
    (v) => v.state === 'live' || v.state === 'pending_release' || v.state === 'phased_release',
  );
  if (published === undefined) return [];
  return [
    {
      track: 'production',
      state: published.state,
      buildNumbers: [],
      ...optional('releaseName', published.version),
      rawTrack: 'App Store',
    },
  ];
}

async function loadPricing(
  client: AppleClient,
  context: AdapterContext,
  appId: string,
): Promise<RemotePricing | undefined> {
  const [priceResource, availabilityResource] = await Promise.all([
    client.one(context, ascCommands.pricingCurrent(appId)),
    client.one(context, ascCommands.pricingAvailabilityView(appId)),
  ]);
  if (priceResource === undefined && availabilityResource === undefined) return undefined;

  const amount = attrString(priceResource, 'customerPrice');
  return {
    ...optional('amount', amount),
    ...optional('free', amount === undefined ? undefined : amount === '0' || amount === '0.00'),
    ...optional('currency', attrString(priceResource, 'currency')),
    ...optional(
      'availableInNewTerritories',
      attrBoolean(availabilityResource, 'availableInNewTerritories'),
    ),
    ...optional('scheduleId', priceResource?.id),
  };
}

/**
 * How many products a snapshot prices.
 *
 * Reading a product's prices costs a call per product, so an app with a hundred of them
 * would turn every plan into a hundred round-trips. The list itself is always complete; only
 * the enrichment is bounded, and the bound is reported as a gap so a differ never mistakes
 * "not read" for "not priced".
 */
const PRICED_PRODUCT_LIMIT = 25;

async function loadProducts(
  client: AppleClient,
  context: AdapterContext,
  ref: AppRef,
): Promise<RemoteProduct[]> {
  const [iaps, subscriptions] = await Promise.all([
    client.list(context, ascCommands.iapList(ref.id, { paginate: true })),
    client.list(context, ascCommands.subscriptionsList(ref.id, { paginate: true })),
  ]);
  const summaries: RemoteProduct[] = [
    ...iaps.map((resource) => toProduct(resource, attrString(resource, 'inAppPurchaseType'))),
    ...subscriptions.map((resource) => toProduct(resource, 'AUTO_RENEWABLE_SUBSCRIPTION')),
  ];

  // A products differ converges on price, so a summary without prices would re-propose the
  // same price on every plan. Enriching here is what makes that convergence real.
  const enriched: RemoteProduct[] = [];
  for (const summary of summaries.slice(0, PRICED_PRODUCT_LIMIT)) {
    const full = await getAppleProductState(
      client,
      context,
      ref,
      summary.productId,
      summary.kind,
    ).catch(() => undefined);
    enriched.push(full ?? summary);
  }
  return [...enriched, ...summaries.slice(PRICED_PRODUCT_LIMIT)];
}

function toProduct(resource: JsonApiResource, rawKind: string | undefined): RemoteProduct {
  return {
    id: resource.id,
    productId: attrString(resource, 'productId') ?? resource.id,
    kind: toProductKind(rawKind),
    ...optional(
      'referenceName',
      attrString(resource, 'name') ?? attrString(resource, 'referenceName'),
    ),
    ...optional(
      'groupId',
      relatedId(resource, 'group') ?? relatedId(resource, 'subscriptionGroup'),
    ),
    ...optional('state', attrString(resource, 'state')),
  };
}

async function loadPhasedRelease(
  client: AppleClient,
  context: AdapterContext,
  versionId: string,
): Promise<RemotePhasedRelease | undefined> {
  const resource = await client.one(context, ascCommands.phasedReleaseView(versionId));
  if (resource === undefined) return undefined;
  const raw = attrString(resource, 'phasedReleaseState');
  const state =
    raw === 'ACTIVE'
      ? 'active'
      : raw === 'PAUSED'
        ? 'paused'
        : raw === 'COMPLETE'
          ? 'complete'
          : 'inactive';
  return {
    track: 'production',
    state,
    id: resource.id,
    ...optional('dayNumber', attrNumber(resource, 'currentDayNumber')),
  };
}
