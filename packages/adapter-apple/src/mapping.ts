import type {
  AppPlatform,
  BuildState,
  ProductKind,
  ReleaseStrategy,
  ReleaseTrack,
  ScreenshotDevice,
  SubmissionState,
  VersionState,
} from '@agentship/core';
import type { AscPlatform } from './commands.js';

/**
 * Translation between Apple's vocabulary and the neutral contract.
 *
 * Kept in one file, and covered by tests, because these tables are the only place where a
 * platform rename can silently corrupt a plan: an unrecognised state that quietly became
 * `draft` would let the engine act as if a live app were still editable. Every table
 * therefore falls back to an explicit `unknown` and preserves the raw value alongside it.
 */

const VERSION_STATES: Readonly<Record<string, VersionState>> = {
  // Editable.
  PREPARE_FOR_SUBMISSION: 'draft',
  DEVELOPER_REJECTED: 'rejected',
  REJECTED: 'rejected',
  METADATA_REJECTED: 'rejected',
  INVALID_BINARY: 'rejected',
  // In Apple's hands.
  WAITING_FOR_REVIEW: 'waiting_review',
  IN_REVIEW: 'in_review',
  PENDING_CONTRACT: 'waiting_review',
  PENDING_APPLE_RELEASE: 'pending_release',
  PENDING_DEVELOPER_RELEASE: 'pending_release',
  PROCESSING_FOR_APP_STORE: 'pending_release',
  PROCESSING_FOR_DISTRIBUTION: 'pending_release',
  ACCEPTED: 'pending_release',
  // Published.
  READY_FOR_SALE: 'live',
  READY_FOR_DISTRIBUTION: 'live',
  // Gone.
  DEVELOPER_REMOVED_FROM_SALE: 'removed',
  REMOVED_FROM_SALE: 'removed',
  REPLACED_WITH_NEW_VERSION: 'removed',
  NOT_APPLICABLE: 'unknown',
};

export function toVersionState(raw: string | undefined): VersionState {
  if (raw === undefined) return 'unknown';
  return VERSION_STATES[raw] ?? 'unknown';
}

const BUILD_STATES: Readonly<Record<string, BuildState>> = {
  PROCESSING: 'processing',
  VALID: 'valid',
  FAILED: 'invalid',
  INVALID: 'invalid',
};

export function toBuildState(raw: string | undefined, expired?: boolean): BuildState {
  if (expired === true) return 'expired';
  if (raw === undefined) return 'unknown';
  return BUILD_STATES[raw] ?? 'unknown';
}

const PLATFORMS: Readonly<Record<string, AppPlatform>> = {
  IOS: 'ios',
  MAC_OS: 'macos',
  TV_OS: 'tvos',
  VISION_OS: 'visionos',
};

export function toAppPlatform(raw: string | undefined): AppPlatform | undefined {
  return raw === undefined ? undefined : PLATFORMS[raw];
}

const ASC_PLATFORMS: Readonly<Record<AppPlatform, AscPlatform | undefined>> = {
  ios: 'IOS',
  macos: 'MAC_OS',
  tvos: 'TV_OS',
  visionos: 'VISION_OS',
  android: undefined,
};

/** Apple platform token for a neutral platform; `IOS` when the caller did not say. */
export function toAscPlatform(platform: AppPlatform | undefined): AscPlatform {
  if (platform === undefined) return 'IOS';
  return ASC_PLATFORMS[platform] ?? 'IOS';
}

const RELEASE_STRATEGIES: Readonly<Record<string, ReleaseStrategy>> = {
  MANUAL: 'manual',
  AFTER_APPROVAL: 'automatic',
  SCHEDULED: 'scheduled',
};

export function toReleaseStrategy(raw: string | undefined): ReleaseStrategy | undefined {
  return raw === undefined ? undefined : RELEASE_STRATEGIES[raw];
}

const ASC_RELEASE_TYPES: Readonly<Record<ReleaseStrategy, string>> = {
  manual: 'MANUAL',
  automatic: 'AFTER_APPROVAL',
  scheduled: 'SCHEDULED',
};

export function toAscReleaseType(strategy: ReleaseStrategy | undefined): string | undefined {
  return strategy === undefined ? undefined : ASC_RELEASE_TYPES[strategy];
}

const SUBMISSION_STATES: Readonly<Record<string, SubmissionState>> = {
  READY_FOR_REVIEW: 'not_submitted',
  WAITING_FOR_REVIEW: 'waiting_review',
  IN_REVIEW: 'in_review',
  UNRESOLVED_ISSUES: 'rejected',
  CANCELING: 'cancelled',
  CANCELLED: 'cancelled',
  COMPLETING: 'approved',
  COMPLETE: 'completed',
};

export function toSubmissionState(raw: string | undefined): SubmissionState {
  if (raw === undefined) return 'unknown';
  return SUBMISSION_STATES[raw] ?? 'unknown';
}

const PRODUCT_KINDS: Readonly<Record<string, ProductKind>> = {
  CONSUMABLE: 'consumable',
  NON_CONSUMABLE: 'non_consumable',
  NON_RENEWING_SUBSCRIPTION: 'non_renewing_subscription',
  NON_RENEWABLE_SUBSCRIPTION: 'non_renewing_subscription',
  AUTO_RENEWABLE_SUBSCRIPTION: 'auto_renewable_subscription',
};

export function toProductKind(raw: string | undefined): ProductKind {
  if (raw === undefined) return 'unknown';
  return PRODUCT_KINDS[raw] ?? 'unknown';
}

/**
 * Which neutral track a TestFlight group belongs to.
 *
 * Apple has no track resource. A group is either internal (team members, no beta review)
 * or external; an external group with a public TestFlight link is open to anyone with the
 * URL, which is what `open_testing` means on the other store.
 */
export function trackForBetaGroup(options: {
  isInternal?: boolean;
  hasPublicLink?: boolean;
}): ReleaseTrack {
  if (options.isInternal === true) return 'internal_testing';
  return options.hasPublicLink === true ? 'open_testing' : 'closed_testing';
}

/** True when a neutral track means "not the App Store" on Apple. */
export function isTestFlightTrack(track: ReleaseTrack): boolean {
  return track !== 'production';
}

/**
 * Neutral device families Apple cannot express.
 *
 * `tablet_7` has no App Store display size — Apple's iPad sets are all 11" or larger — so
 * a plan targeting it is reported as a warning rather than silently dropped.
 */
export const UNSUPPORTED_DEVICES: readonly ScreenshotDevice[] = ['tablet_7'];
