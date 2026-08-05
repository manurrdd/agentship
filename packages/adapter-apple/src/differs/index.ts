import type { PendingVerifier, ResourceDiffer } from '@agentship/core';
import { appleBuildDiffer } from './build.js';
import { appleMetadataDiffer } from './metadata.js';
import { applePricingDiffer } from './pricing.js';
import { applePrivacyDiffer } from './privacy.js';
import { appleProductsDiffer } from './products.js';
import { applePhasedReleaseDiffer, appleReleaseDiffer } from './release.js';
import { appleReviewDiffer } from './review.js';
import { appleScreenshotsDiffer } from './screenshots.js';
import { appleTestFlightDiffer } from './testflight.js';
import { appleVersionDiffer } from './version.js';
import { isEditable } from './version-state-rules.js';

export { appleBuildDiffer } from './build.js';
export { appleMetadataDiffer } from './metadata.js';
export { applePricingDiffer } from './pricing.js';
export { applePrivacyDiffer } from './privacy.js';
export { appleProductsDiffer } from './products.js';
export { applePhasedReleaseDiffer, appleReleaseDiffer, manualReleasePending } from './release.js';
export { appleReviewDiffer } from './review.js';
export { appleScreenshotsDiffer } from './screenshots.js';
export { appleTestFlightDiffer } from './testflight.js';
export { appleVersionDiffer, resolutionCenterPending } from './version.js';
export {
  type AppleVersionAction,
  explainIllegal,
  findVersion,
  type IllegalRemedy,
  isEditable,
  isSubmitted,
  type Legality,
  versionActionLegality,
} from './version-state-rules.js';

/**
 * Every differ that plans an App Store release, in one list.
 *
 * They are independent on purpose: each owns one resource, reads the manifest and the fresh
 * snapshot, and emits drafts for the gap. Ordering between them is expressed as optional
 * dependencies between drafts, not as a position in this array — so a plan that contains
 * only some of them still runs in the right order.
 */
export function appleDiffers(): readonly ResourceDiffer[] {
  return [
    appleVersionDiffer(),
    appleMetadataDiffer(),
    appleScreenshotsDiffer(),
    applePricingDiffer(),
    appleProductsDiffer(),
    applePrivacyDiffer(),
    appleBuildDiffer(),
    appleTestFlightDiffer(),
    appleReviewDiffer(),
    applePhasedReleaseDiffer(),
    appleReleaseDiffer(),
  ];
}

/**
 * Verifiers for the console work Apple's differs emit.
 *
 * Each one answers its question from a fresh snapshot only. Nothing here trusts that a
 * pending operation was marked done: `verified` means the store showed the effect.
 */
export const APPLE_VERIFIERS: ReadonlyMap<string, PendingVerifier> = new Map<
  string,
  PendingVerifier
>([
  [
    'apple:version-editable',
    (operation, state) => {
      const version = operation.verification?.params?.['version'];
      const found = state.versions.find((candidate) => candidate.version === version);
      return found !== undefined && isEditable(found.state);
    },
  ],
  [
    'apple:version-live',
    (operation, state) => {
      const version = operation.verification?.params?.['version'];
      const found = state.versions.find((candidate) => candidate.version === version);
      return found !== undefined && (found.state === 'live' || found.state === 'phased_release');
    },
  ],
  [
    // Reading the app back at all proves the record exists; when the catalog entry supplied
    // a bundle id, it must be the one the store reports, so a right answer about the wrong
    // app cannot pass.
    'apple:app-exists',
    (operation, state) => {
      const bundleId = operation.verification?.params?.['bundleId'];
      if (state.app.ref.id === '') return false;
      return bundleId === undefined || state.app.bundleId === bundleId;
    },
  ],
]);
