import type {
  BuildState,
  ProductKind,
  ReleaseTrack,
  ScreenshotDevice,
  VersionState,
} from '@agentship/core';
import { z } from 'zod';
import { GOOGLE_SCREENSHOT_TYPES, TRACK_BY_GOOGLE_NAME } from './commands.js';

/**
 * Shapes `gpc` prints, and the translation into the neutral contract.
 *
 * Under `--output json`, `gpc` prints the Google Play Developer API resource verbatim
 * (a `Listing`, an `Image`, a `Track`), except for list commands that wrap the array in
 * `{ <items>, nextPageToken, meta }`. Every schema below is `loose`: Google adds fields
 * between API revisions, and a strict schema would turn each addition into an outage.
 */

export const listingSchema = z
  .object({
    language: z.string(),
    title: z.string().optional(),
    shortDescription: z.string().optional(),
    fullDescription: z.string().optional(),
    video: z.string().optional(),
  })
  .loose();

export const listingListSchema = z.array(listingSchema);

export const imageSchema = z
  .object({
    id: z.string(),
    url: z.string().optional(),
    sha1: z.string().optional(),
    sha256: z.string().optional(),
  })
  .loose();

export const imageListSchema = z.array(imageSchema);

export const releaseNoteSchema = z.object({ language: z.string(), text: z.string() }).loose();

export const releaseStatusSchema = z
  .object({
    track: z.string(),
    status: z.string().optional(),
    name: z.string().optional(),
    versionCodes: z.array(z.union([z.string(), z.number()])).optional(),
    userFraction: z.number().optional(),
    releaseNotes: z.array(releaseNoteSchema).optional(),
  })
  .loose();

export const releaseStatusListSchema = z.array(releaseStatusSchema);

export const appDetailsSchema = z
  .object({
    packageName: z.string().optional(),
    defaultLanguage: z.string().optional(),
    contactEmail: z.string().optional(),
  })
  .loose();

export const bundleSchema = z
  .object({
    versionCode: z.number(),
    sha256: z.string().optional(),
    sha1: z.string().optional(),
  })
  .loose();

export const bundleListSchema = z.array(bundleSchema);

/** `gpc testers list` wraps the Google Group addresses. */
export const testersSchema = z.object({ googleGroups: z.array(z.string()).optional() }).loose();

/** `gpc releases upload` / `assign` print their own summary of what they committed. */
export const releaseResultSchema = z
  .object({
    versionCode: z.union([z.string(), z.number()]).optional(),
    track: z.string().optional(),
    status: z.string().optional(),
    validateOnly: z.boolean().optional(),
    reviewPending: z.boolean().optional(),
    reviewSkipped: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    nextStep: z.string().optional(),
  })
  .loose();

/** `gpc listings images sync` reports what it uploaded, skipped and deleted. */
export const imageSyncResultSchema = z
  .object({
    uploaded: z.number().optional(),
    skipped: z.number().optional(),
    deleted: z.number().optional(),
    total: z.number().optional(),
  })
  .loose();

const productSchema = z
  .object({
    sku: z.string().optional(),
    productId: z.string().optional(),
    packageName: z.string().optional(),
    purchaseType: z.string().optional(),
    status: z.string().optional(),
    listings: z.record(z.string(), z.object({ title: z.string().optional() }).loose()).optional(),
  })
  .loose();

/**
 * Reads a list from whatever envelope the command used.
 *
 * `gpc` is inconsistent here — some list commands print a bare array, others wrap it under
 * a named key with pagination metadata — so callers name the key they expect and get a
 * bare array either way.
 */
export function unwrapList(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

export function parseProducts(value: unknown, key: string): z.infer<typeof productSchema>[] {
  return unwrapList(value, key)
    .map((entry) => productSchema.safeParse(entry))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
}

// --- enum translation -------------------------------------------------------------

const RELEASE_STATES: Readonly<Record<string, VersionState>> = {
  draft: 'draft',
  completed: 'live',
  inProgress: 'phased_release',
  halted: 'phased_release',
};

export function toVersionState(raw: string | undefined): VersionState {
  if (raw === undefined) return 'unknown';
  return RELEASE_STATES[raw] ?? 'unknown';
}

export function toTrack(raw: string | undefined): ReleaseTrack | undefined {
  return raw === undefined ? undefined : TRACK_BY_GOOGLE_NAME[raw];
}

/**
 * Play reports a bundle as processed or not at all: a version code that `bundles list`
 * returns has finished processing, and one it does not return either failed or is still
 * being processed. The distinction is made by the caller, which knows whether it just
 * uploaded.
 */
export function toBuildState(found: boolean): BuildState {
  return found ? 'valid' : 'processing';
}

const PRODUCT_KINDS: Readonly<Record<string, ProductKind>> = {
  managedUser: 'non_consumable',
  subscription: 'auto_renewable_subscription',
};

export function toProductKind(raw: string | undefined): ProductKind {
  if (raw === undefined) return 'unknown';
  return PRODUCT_KINDS[raw] ?? 'unknown';
}

/** Reverse of {@link GOOGLE_SCREENSHOT_TYPES}. */
export const DEVICE_BY_GOOGLE_TYPE = new Map<string, ScreenshotDevice>(
  Object.entries(GOOGLE_SCREENSHOT_TYPES)
    .filter((entry): entry is [ScreenshotDevice, string] => entry[1] !== undefined)
    .map(([device, googleType]) => [googleType, device]),
);
