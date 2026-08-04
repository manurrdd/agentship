import type { PendingVerifier, ResourceDiffer } from '@agentship/core';
import { googleImagesDiffer, googleListingDiffer } from './listing.js';
import { googlePrivacyDiffer } from './privacy.js';
import { googleProductsDiffer } from './products.js';
import { googleBundleDiffer, googleReleaseDiffer } from './release.js';
import { googlePromoteDiffer, googleRolloutDiffer } from './rollout.js';
import { googleTestersDiffer } from './testers.js';

export {
  editGroupDependencies,
  GOOGLE_EDIT_GROUP,
  GOOGLE_EDIT_GROUP_KEYS,
  GOOGLE_POST_COMMIT,
  type GoogleActionKind,
  groupsIntoOneBatch,
} from './edit-grouping.js';
export { googleImagesDiffer, googleListingDiffer } from './listing.js';
export { googlePrivacyDiffer } from './privacy.js';
export { googleProductsDiffer } from './products.js';
export {
  googleBundleDiffer,
  googleReleaseDiffer,
  managedPublishingPending,
} from './release.js';
export { googlePromoteDiffer, googleRolloutDiffer } from './rollout.js';
export { googleTestersDiffer } from './testers.js';

/** Every differ that plans a Google Play release. */
export function googleDiffers(): readonly ResourceDiffer[] {
  return [
    googleTestersDiffer(),
    googleProductsDiffer(),
    googlePrivacyDiffer(),
    googleListingDiffer(),
    googleImagesDiffer(),
    googleBundleDiffer(),
    googleReleaseDiffer(),
    googleRolloutDiffer(),
    googlePromoteDiffer(),
  ];
}

/**
 * Verifiers for the console work Google's differs emit.
 *
 * Play exposes no review status, so none of these claim one. Each answers a question the API
 * *can* answer — is the track serving this build, does it list these testers — which is
 * weaker than "the console work was done correctly" and is described as such.
 */
export const GOOGLE_VERIFIERS: ReadonlyMap<string, PendingVerifier> = new Map<
  string,
  PendingVerifier
>([
  [
    'google:track-live',
    (operation, state) => {
      const track = operation.verification?.params?.['track'];
      const found = state.tracks.find((candidate) => candidate.track === track);
      return found !== undefined && found.buildNumbers.length > 0 && found.state === 'live';
    },
  ],
  [
    'google:track-testers',
    (operation, state) => {
      const track = operation.verification?.params?.['track'];
      return state.testerGroups.some((group) => group.track === track && group.members.length > 0);
    },
  ],
  [
    'google:content-rating',
    (_operation, state) => !state.pending.some((pending) => pending.category === 'content_rating'),
  ],
  [
    // Play has no endpoint that enumerates apps, so "the app exists" is answered by the app
    // details call succeeding for this package name — which is exactly what a snapshot is.
    'google:app-exists',
    (operation, state) => {
      const packageName = operation.verification?.params?.['packageName'];
      if (state.app.ref.id === '') return false;
      return packageName === undefined || state.app.ref.id === packageName;
    },
  ],
  [
    // The first release is the gate that makes API uploads possible at all; a track serving
    // a build is the observable consequence.
    'google:first-release-done',
    (_operation, state) => state.tracks.some((track) => track.buildNumbers.length > 0),
  ],
  [
    // Play exposes no endpoint for the App content answers. The one thing a snapshot can say
    // is that the store stopped reporting them as outstanding — weaker than "answered
    // correctly", and described as such in the catalog entry.
    'google:app-content-done',
    (_operation, state) => !state.pending.some((pending) => pending.category === 'privacy'),
  ],
]);
