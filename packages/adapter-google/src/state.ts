import {
  type AdapterContext,
  AgentshipError,
  type AppRef,
  type AppSummary,
  ERROR_CODES,
  optional,
  type RemoteAppState,
  type RemoteBuild,
  type RemoteImageSet,
  type RemoteLocalization,
  type RemotePhasedRelease,
  type RemoteProduct,
  type RemoteTesterGroup,
  type RemoteTrackState,
  type RemoteVersion,
  type StateGap,
} from '@agentship/core';
import { GOOGLE_PENDING_OPERATIONS } from './capabilities.js';
import type { GoogleClient } from './client.js';
import {
  ALL_GOOGLE_IMAGE_TYPES,
  GOOGLE_SLOT_TYPES,
  GOOGLE_TRACKS,
  gpcCommands,
} from './commands.js';
import { getGoogleProductState } from './monetization.js';
import {
  appDetailsSchema,
  bundleListSchema,
  DEVICE_BY_GOOGLE_TYPE,
  imageListSchema,
  listingListSchema,
  parseProducts,
  releaseStatusListSchema,
  testersSchema,
  toProductKind,
  toTrack,
  toVersionState,
  unwrapList,
} from './schema.js';

/**
 * Assembling the snapshot.
 *
 * Google charges an *edit* for almost every read: `gpc` opens one, reads, and discards it.
 * That makes a naive snapshot both slow and a source of edit contention, so the sections
 * here are deliberately few and each is a single `gpc` call. Screenshots are the exception
 * — Play only lists images one language and type at a time — and are therefore bounded to
 * the locales the listing actually has.
 *
 * As on Apple, only the app lookup may fail the whole call; every other section degrades to
 * a {@link StateGap} so the kernel can tell "absent" from "unknown".
 */

const SCREENSHOT_LOCALE_LIMIT = 20;

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

/** Gaps Google always has, whatever the credentials. Reported so they are never mistaken for data. */
const PERMANENT_GAPS: readonly StateGap[] = [
  {
    area: 'pricing',
    reason:
      'The Google Play Developer API does not expose the app price, its free/paid status or its country availability. Those live in Play Console.',
    kind: 'no_api',
    pendingId: 'google:pricing-and-countries',
  },
  {
    area: 'dataSafety',
    reason:
      'The Play Developer API can update the Data Safety declaration but has no endpoint to read it back. Agentship compares against the copy it archived after the last apply instead.',
    kind: 'no_api',
    pendingId: 'google:app-content',
  },
  {
    area: 'ageRating',
    reason:
      'Content ratings are issued by IARC through a console questionnaire; Google exposes no API for the answers or for the resulting rating.',
    kind: 'no_api',
    pendingId: 'google:content-rating',
  },
];

export async function getGoogleAppState(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
): Promise<RemoteAppState> {
  const gaps: StateGap[] = [...PERMANENT_GAPS];
  const packageName = ref.id;

  const details = appDetailsSchema.parse(
    await client.json(context, gpcCommands.appInfo(packageName)),
  );

  const releases = await section(gaps, 'tracks', [] as RemoteTrackState[], async () => {
    const raw = await client.json(context, gpcCommands.releasesStatus(packageName));
    return releaseStatusListSchema.parse(unwrapList(raw, 'releases')).map(toTrackState);
  });

  const listings = await section(gaps, 'localizations', [] as RemoteLocalization[], async () => {
    const raw = await client.json(context, gpcCommands.listingsGet(packageName));
    return listingListSchema.parse(unwrapList(raw, 'listings')).map(
      (listing): RemoteLocalization => ({
        locale: listing.language,
        ...optional('name', listing.title),
        ...optional('shortDescription', listing.shortDescription),
        ...optional('description', listing.fullDescription),
        ...optional('videoUrl', listing.video),
      }),
    );
  });

  const images = await section(gaps, 'images', [] as RemoteImageSet[], () =>
    loadImages(
      client,
      context,
      packageName,
      listings.map((listing) => listing.locale),
    ),
  );

  const builds = await section(gaps, 'builds', [] as RemoteBuild[], async () => {
    const raw = await client.json(context, gpcCommands.bundlesList(packageName));
    return bundleListSchema.parse(unwrapList(raw, 'bundles')).map(
      (bundle): RemoteBuild => ({
        // Play has no build id; the version code is the only stable handle.
        id: String(bundle.versionCode),
        buildNumber: String(bundle.versionCode),
        state: 'valid',
        platform: 'android',
      }),
    );
  });

  const testerGroups = await section(gaps, 'testerGroups', [] as RemoteTesterGroup[], () =>
    loadTesterGroups(client, context, packageName),
  );

  const products = await section(gaps, 'products', [] as RemoteProduct[], () =>
    loadProducts(client, context, ref),
  );

  return {
    store: 'google',
    ref,
    capturedAt: new Date().toISOString(),
    app: toAppSummary(ref, details.defaultLanguage),
    // Play has no version resource: what exists is a release on a track, so each track's
    // current release is surfaced as the version it serves.
    versions: releases.map(toRemoteVersion),
    localizations: listings,
    images,
    builds,
    testerGroups,
    tracks: releases,
    products,
    ...optional('phasedRelease', toPhasedRelease(releases)),
    gaps,
    pending: GOOGLE_PENDING_OPERATIONS,
  };
}

export function toAppSummary(ref: AppRef, defaultLanguage: string | undefined): AppSummary {
  return {
    ref: { ...ref, bundleId: ref.id, platform: 'android' },
    // Play's app details carry no display name; the listing title in the default language
    // is the closest thing, and the caller reads it from `localizations`.
    name: ref.id,
    bundleId: ref.id,
    ...optional('primaryLocale', defaultLanguage),
    platforms: ['android'],
  };
}

function toTrackState(release: {
  track: string;
  status?: string | undefined;
  name?: string | undefined;
  versionCodes?: (string | number)[] | undefined;
  userFraction?: number | undefined;
  releaseNotes?: { language: string; text: string }[] | undefined;
}): RemoteTrackState {
  const track = toTrack(release.track);
  return {
    // A custom Play track has no neutral equivalent; it is reported under closed testing,
    // with its real name preserved so nothing is silently renamed.
    track: track ?? 'closed_testing',
    state: toVersionState(release.status),
    buildNumbers: (release.versionCodes ?? []).map(String),
    ...optional('userFraction', release.userFraction),
    ...optional('halted', release.status === 'halted' ? true : undefined),
    ...optional('releaseName', release.name),
    ...optional(
      'notes',
      release.releaseNotes?.map((note) => ({ locale: note.language, text: note.text })),
    ),
    rawTrack: release.track,
  };
}

function toRemoteVersion(track: RemoteTrackState): RemoteVersion {
  return {
    id: `${track.rawTrack ?? track.track}:${track.buildNumbers.join(',')}`,
    version: track.releaseName ?? track.buildNumbers.join(','),
    state: track.state,
    platform: 'android',
    track: track.track,
    ...optional('buildId', track.buildNumbers[0]),
  };
}

/** A staged rollout in progress is Google's equivalent of Apple's phased release. */
function toPhasedRelease(tracks: readonly RemoteTrackState[]): RemotePhasedRelease | undefined {
  const rolling = tracks.find((track) => track.userFraction !== undefined);
  if (rolling === undefined) return undefined;
  return {
    track: rolling.track,
    state: rolling.halted === true ? 'paused' : 'active',
    ...optional('userFraction', rolling.userFraction),
  };
}

async function loadImages(
  client: GoogleClient,
  context: AdapterContext,
  packageName: string,
  locales: readonly string[],
): Promise<RemoteImageSet[]> {
  const sets: RemoteImageSet[] = [];
  const slotByType = new Map(
    Object.entries(GOOGLE_SLOT_TYPES).map(([slot, type]) => [type, slot] as const),
  );

  for (const locale of locales.slice(0, SCREENSHOT_LOCALE_LIMIT)) {
    for (const imageType of ALL_GOOGLE_IMAGE_TYPES) {
      const raw = await client.json(
        context,
        gpcCommands.imagesList(packageName, locale, imageType),
      );
      const images = imageListSchema.parse(unwrapList(raw, 'images'));
      if (images.length === 0) continue;
      const device = DEVICE_BY_GOOGLE_TYPE.get(imageType);
      sets.push({
        locale,
        device: device ?? 'phone',
        slot: (slotByType.get(imageType) as RemoteImageSet['slot']) ?? 'screenshots',
        images: images.map((image) => ({
          id: image.id,
          ...optional('sha256', image.sha256?.toLowerCase()),
          ...optional('url', image.url),
        })),
      });
    }
  }
  return sets;
}

/**
 * Play's testers are Google Groups attached to a track, not named groups of individuals.
 * Each track therefore yields at most one neutral tester group, named after the track.
 */
async function loadTesterGroups(
  client: GoogleClient,
  context: AdapterContext,
  packageName: string,
): Promise<RemoteTesterGroup[]> {
  const groups: RemoteTesterGroup[] = [];
  for (const [track, googleTrack] of Object.entries(GOOGLE_TRACKS)) {
    if (googleTrack === 'production') continue;
    const parsed = testersSchema.safeParse(
      await client.json(context, gpcCommands.testersList(packageName, googleTrack)),
    );
    const members = parsed.success ? (parsed.data.googleGroups ?? []) : [];
    if (members.length === 0) continue;
    groups.push({
      id: googleTrack,
      name: googleTrack,
      track: track as RemoteTesterGroup['track'],
      kind: 'google_groups',
      members,
    });
  }
  return groups;
}

/**
 * How many products a snapshot prices.
 *
 * On Play a price is a field of the product document, so reading prices means fetching each
 * product in full — one call each. The list stays complete; only the enrichment is bounded.
 */
const PRICED_PRODUCT_LIMIT = 25;

async function loadProducts(
  client: GoogleClient,
  context: AdapterContext,
  ref: AppRef,
): Promise<RemoteProduct[]> {
  const packageName = ref.id;
  const [iaps, subscriptions] = await Promise.all([
    client.json(context, gpcCommands.iapList(packageName)),
    client.json(context, gpcCommands.subscriptionsList(packageName)),
  ]);
  const summaries: RemoteProduct[] = [
    ...parseProducts(iaps, 'oneTimeProducts').map((product) => ({
      id: product.productId ?? product.sku ?? '',
      productId: product.productId ?? product.sku ?? '',
      kind: toProductKind(product.purchaseType),
      ...optional('state', product.status),
    })),
    ...parseProducts(subscriptions, 'subscriptions').map((product) => ({
      id: product.productId ?? '',
      productId: product.productId ?? '',
      kind: 'auto_renewable_subscription' as const,
      ...optional('state', product.status),
    })),
  ].filter((product) => product.productId !== '');

  // Without prices, a products differ would re-propose the same price on every plan; this is
  // what makes its convergence real rather than nominal.
  const enriched: RemoteProduct[] = [];
  for (const summary of summaries.slice(0, PRICED_PRODUCT_LIMIT)) {
    const full = await getGoogleProductState(
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
