import { pendingOf, renderPending } from '@agentship/catalog';
import type {
  ActionDraft,
  DifferInput,
  PendingOperation,
  ReleaseTrack,
  ResourceDiffer,
} from '@agentship/core';
import {
  isNeedsInput,
  plannedArtifactPath,
  resolveArtifactPath,
  usableArtifact,
} from '@agentship/core';
import { editGroupDependencies, monetizationDependencies } from './edit-grouping.js';

/**
 * `google/bundle` — upload the app bundle, once.
 *
 * Play refuses a version code it has already seen, which makes a double upload loud rather
 * than silent. Agentship never relies on that: the differ asks the fresh snapshot whether the
 * version code is already there and drafts nothing when it is. The store's refusal is the
 * backstop, not the mechanism.
 */
export function googleBundleDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'bundle',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const release = input.manifest.release;
      const versionCode = release.buildNumber;
      const needsInput: string[] = [];
      if (isNeedsInput(release.version)) needsInput.push('release.version');
      if (versionCode === undefined || isNeedsInput(versionCode)) {
        needsInput.push('release.buildNumber');
      }

      if (versionCode !== undefined && !isNeedsInput(versionCode)) {
        const known =
          input.state.builds.some((build) => build.buildNumber === versionCode) ||
          input.state.tracks.some((track) => track.buildNumbers.includes(versionCode));
        if (known) return [];
      }

      const artifact =
        needsInput.length > 0
          ? undefined
          : await usableArtifact(input.repoRoot, 'google', {
              version: release.version,
              buildNumber: versionCode as string,
            });
      const declared = release.artifacts?.google;
      const kind = artifact?.kind ?? declared?.kind ?? 'aab';
      const path =
        artifact?.path ??
        (declared === undefined
          ? needsInput.length > 0
            ? undefined
            : plannedArtifactPath(
                input.repoRoot,
                'google',
                kind,
                release.version,
                versionCode as string,
              )
          : resolveArtifactPath(input.repoRoot, declared.path));

      return [
        {
          kind: 'upload_build',
          target: `bundle/${versionCode ?? 'unknown'}`,
          operation: 'uploadBuild',
          summary: `Upload version code ${versionCode ?? '?'} (${release.version}) to Google Play`,
          diff: [
            {
              path: `bundles.${versionCode ?? '?'}`,
              after: release.version,
              ...(artifact === undefined
                ? {}
                : { note: `sha256 ${artifact.sha256.slice(0, 12)}…, ${artifact.sizeBytes} bytes` }),
            },
          ],
          dependsOn: [
            { kind: 'build', target: `android/${release.version}`, optional: true },
            ...editGroupDependencies('upload_build', versionCode),
            ...monetizationDependencies(input.manifest),
          ],
          ...(needsInput.length > 0
            ? { needsInput }
            : {
                op: {
                  op: 'upload_build',
                  artifact: {
                    path: path as string,
                    kind: kind as 'aab' | 'apk',
                    version: release.version,
                    buildNumber: versionCode as string,
                  },
                },
              }),
          riskNotes: [
            'Google Play rejects a version code it has already seen; Agentship only drafts this when the store shows none.',
          ],
        },
      ];
    },
  };
}

/** The console step managed publishing leaves behind: a human presses Publish. */
export function managedPublishingPending(track: ReleaseTrack): PendingOperation {
  return pendingOf(
    renderPending('google:managed-publishing', { context: { 'release.track': track } }),
  );
}

/**
 * `google/release` — put the version code on a track and commit the edit.
 *
 * This is the action that submits: on Play, committing an edit *is* the submission, and the
 * only switch that separates them is `--changes-not-sent-for-review`. Managed publishing
 * uses exactly that switch — the changes are staged and reviewed, and a human presses
 * Publish — so the console step is emitted alongside, gated on the same release.
 *
 * A staged rollout starts here too, when the manifest asks for one: `userFraction` is part
 * of creating the release, not a separate call.
 */
export function googleReleaseDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'release',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      const versionCode = release.buildNumber;
      const needsInput: string[] = [];
      if (isNeedsInput(release.version)) needsInput.push('release.version');
      if (versionCode === undefined || isNeedsInput(versionCode)) {
        needsInput.push('release.buildNumber');
      }
      // A promotion is a different action; this one publishes a fresh build.
      if (release.promoteFrom !== undefined) return [];

      const track = input.state.tracks.find((candidate) => candidate.track === release.track);
      if (
        versionCode !== undefined &&
        track?.buildNumbers.includes(versionCode) === true &&
        // A track already serving this build at the requested fraction is converged.
        (release.rollout === undefined || track.userFraction === release.rollout)
      ) {
        return [];
      }

      const contentRating = input.state.pending.find(
        (pending) => pending.category === 'content_rating',
      );
      const managed = release.managedPublishing === true;
      const production = release.track === 'production';

      return [
        {
          kind: 'submit_for_review',
          target: 'release',
          operation: 'submitForReview',
          summary: `Release version code ${versionCode ?? '?'} (${release.version}) to the ${release.track} track${release.rollout === undefined ? '' : ` at ${Math.round(release.rollout * 100)}%`}${managed ? ', staged for manual publishing' : ''}`,
          diff: [
            {
              path: `tracks.${release.track}.buildNumbers`,
              before: track === undefined ? 'none' : track.buildNumbers.join(', ') || 'none',
              after: versionCode ?? '?',
            },
            ...(release.rollout === undefined
              ? []
              : [
                  {
                    path: `tracks.${release.track}.userFraction`,
                    before: track?.userFraction ?? 'none',
                    after: release.rollout,
                  },
                ]),
          ],
          dependsOn: [
            ...editGroupDependencies('submit_for_review', versionCode),
            ...monetizationDependencies(input.manifest),
          ],
          ...(contentRating === undefined ? {} : { blockedBy: [contentRating.id] }),
          ...(managed ? { pending: managedPublishingPending(release.track) } : {}),
          ...(needsInput.length > 0
            ? { needsInput }
            : {
                op: {
                  op: 'submit_for_review',
                  submission: {
                    version: release.version,
                    buildNumber: versionCode as string,
                    track: release.track,
                    ...(managed ? { withoutReview: true } : {}),
                  },
                },
              }),
          production,
          riskNotes: [
            ...(production
              ? ['This reaches App Store customers on Google Play once the review finishes.']
              : [`This reaches the testers on the ${release.track} track.`]),
            ...(managed
              ? [
                  'Managed publishing is on: the change is committed and reviewed, but stays invisible until a human presses Publish in Play Console.',
                ]
              : []),
            'Committing a Play edit while a review is already running would cancel that review; Agentship refuses instead, and reports CHANGES_ALREADY_IN_REVIEW.',
          ],
        },
      ];
    },
  };
}
