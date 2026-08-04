import type { RemoteVersion, VersionState } from '@agentship/core';

/**
 * What App Store Connect allows in each version state.
 *
 * The App Store is a state machine with a rule almost every release tool learns the hard
 * way: once a version enters review, its metadata freezes. Editing it does not fail
 * gracefully — depending on the field it either errors, or silently cancels the submission.
 *
 * So the rules live here as data, and the differs consult them *before* drafting. A plan
 * therefore never contains an action the store would reject: what would have been an action
 * becomes a blocked one with an explanation, or a pending operation naming the decision only
 * a human can take. "Withdraw the submission" is the clearest example — it is reversible in
 * the API sense and catastrophic in the human sense, because it can cost days of review
 * queue, so Agentship states the option and stops.
 */
export type AppleVersionAction =
  | 'ensure_version'
  | 'set_metadata'
  | 'sync_screenshots'
  | 'attach_build'
  | 'submit_for_review'
  | 'set_phased_release'
  | 'release_version';

/** Why an action is not legal right now, and what would make it legal. */
export type IllegalRemedy =
  /** Nothing to do but wait for App Review. */
  | 'wait_for_review'
  /** A human must withdraw the submission in App Store Connect. */
  | 'withdraw_submission'
  /** The change belongs in a new version, not this one. */
  | 'new_version'
  /** The reviewer is waiting for an answer in Resolution Center. */
  | 'resolution_center'
  /** The version has not reached the state this action applies to. */
  | 'not_yet';

export interface Legality {
  readonly legal: boolean;
  readonly reason?: string;
  readonly remedy?: IllegalRemedy;
}

const LEGAL = { legal: true } as const;

/** Actions each unified version state accepts. Anything absent is illegal. */
const ALLOWED: Readonly<Record<VersionState, readonly AppleVersionAction[]>> = {
  draft: [
    'ensure_version',
    'set_metadata',
    'sync_screenshots',
    'attach_build',
    'submit_for_review',
  ],
  // Apple's DEVELOPER_REJECTED / REJECTED / METADATA_REJECTED all land here: the version is
  // editable again and can be resubmitted, which is exactly the iterate-after-rejection loop.
  rejected: [
    'ensure_version',
    'set_metadata',
    'sync_screenshots',
    'attach_build',
    'submit_for_review',
  ],
  waiting_review: [],
  in_review: [],
  // Approved and held for a manual release: only the release itself is left.
  pending_release: ['release_version', 'set_phased_release'],
  phased_release: ['set_phased_release'],
  live: ['set_phased_release'],
  removed: [],
  unknown: [],
};

const REASONS: Readonly<Record<VersionState, { reason: string; remedy: IllegalRemedy }>> = {
  draft: { reason: 'the version is still being prepared', remedy: 'not_yet' },
  rejected: { reason: 'the version was rejected', remedy: 'resolution_center' },
  waiting_review: {
    reason: 'the version is waiting for App Review, and its content is frozen',
    remedy: 'withdraw_submission',
  },
  in_review: {
    reason: 'App Review is looking at the version right now, and its content is frozen',
    remedy: 'wait_for_review',
  },
  pending_release: {
    reason: 'the version is approved and waiting to be released; its content is frozen',
    remedy: 'new_version',
  },
  phased_release: {
    reason: 'the version is already rolling out to users',
    remedy: 'new_version',
  },
  live: { reason: 'the version is live on the App Store', remedy: 'new_version' },
  removed: { reason: 'the version was removed from sale', remedy: 'new_version' },
  unknown: {
    reason: 'App Store Connect reported a state Agentship does not recognise',
    remedy: 'wait_for_review',
  },
};

/** Whether an action is legal against a version in this state. */
export function versionActionLegality(action: AppleVersionAction, state: VersionState): Legality {
  if ((ALLOWED[state] ?? []).includes(action)) return LEGAL;
  const { reason, remedy } = REASONS[state];
  return { legal: false, reason, remedy };
}

/** One sentence an agent can relay, naming the state and the way out. */
export function explainIllegal(
  action: AppleVersionAction,
  version: RemoteVersion,
  legality: Legality,
): string {
  const remedy: Readonly<Record<IllegalRemedy, string>> = {
    wait_for_review: 'Wait for App Review to finish; Agentship will re-plan once the state moves.',
    withdraw_submission:
      'Only a human can withdraw the submission in App Store Connect, and doing so loses the place in the review queue.',
    new_version: `Bump release.version in the manifest: this change belongs in a version after ${version.version}.`,
    resolution_center:
      'Read the reviewer’s message in Resolution Center, fix the cause, and resubmit.',
    not_yet: 'The version has not reached the state this action applies to yet.',
  };
  return `"${action}" is not possible on version ${version.version}: ${legality.reason ?? 'the store does not allow it'}. ${remedy[legality.remedy ?? 'not_yet']}`;
}

/** The version a release targets, when the store already has it. */
export function findVersion(
  versions: readonly RemoteVersion[],
  version: string,
): RemoteVersion | undefined {
  return versions.find((candidate) => candidate.version === version);
}

/** States in which the version still accepts edits. */
export function isEditable(state: VersionState): boolean {
  return state === 'draft' || state === 'rejected';
}

/** States that mean the version has already been handed to the store for this release. */
export function isSubmitted(state: VersionState): boolean {
  return (
    state === 'waiting_review' ||
    state === 'in_review' ||
    state === 'pending_release' ||
    state === 'phased_release' ||
    state === 'live'
  );
}
