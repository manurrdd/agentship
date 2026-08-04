import type { ActionDraft, DifferInput, ResourceDiffer } from '@agentship/core';
import { isNeedsInput } from '@agentship/core';
import { editGroupDependencies } from './edit-grouping.js';

/**
 * `google/rollout` — moving a staged rollout, only ever on instruction.
 *
 * The rule this differ exists to enforce: **Agentship never raises a rollout fraction on its
 * own.** A staged rollout is a safety mechanism — you watch crash rates and decide. A tool
 * that advanced it automatically would be removing the only thing the mechanism is for. So
 * the differ converges on the fraction the manifest states, and every move is
 * `needs_approval` because it reaches more users than it did a moment ago.
 *
 * Lowering is not possible on Play, and Agentship does not pretend: a manifest asking for less
 * than the store already serves produces an explanation, not an action.
 */
export function googleRolloutDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'rollout',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      const wanted = release.rollout;
      if (wanted === undefined || isNeedsInput(release.version)) return [];

      const track = input.state.tracks.find((candidate) => candidate.track === release.track);
      if (track === undefined) return [];
      // The release differ creates the release with its fraction; this one only moves an
      // existing rollout, so a track that is not serving anything yet is not its business.
      if (track.buildNumbers.length === 0) return [];

      const current = track.userFraction ?? (track.state === 'live' ? 1 : 0);
      if (current === wanted) return [];

      if (current > wanted) {
        return [
          {
            kind: 'set_phased_release',
            target: 'rollout',
            operation: 'setPhasedRelease',
            summary: `The ${release.track} rollout is already at ${Math.round(current * 100)}%, past the ${Math.round(wanted * 100)}% the manifest asks for`,
            diff: [
              {
                path: `tracks.${release.track}.userFraction`,
                before: current,
                after: wanted,
                note: 'Google Play cannot reduce a staged rollout. Halt it, or publish a new release.',
              },
            ],
            needsInput: ['release.rollout'],
            riskNotes: [
              'A rollout can be halted or completed, never rolled back to a smaller fraction. Lower release.rollout in the manifest only when starting a new release.',
            ],
          },
        ];
      }

      const complete = wanted >= 1;
      return [
        {
          kind: 'set_phased_release',
          target: 'rollout',
          operation: 'setPhasedRelease',
          summary: complete
            ? `Complete the ${release.track} rollout (100% of users)`
            : `Raise the ${release.track} rollout from ${Math.round(current * 100)}% to ${Math.round(wanted * 100)}%`,
          diff: [
            {
              path: `tracks.${release.track}.userFraction`,
              before: current,
              after: wanted,
            },
          ],
          dependsOn: [...editGroupDependencies('set_phased_release', release.buildNumber)],
          op: {
            op: 'set_phased_release',
            action: {
              action: complete ? 'complete' : 'resume',
              track: release.track,
              ...(complete ? {} : { userFraction: wanted }),
            },
          },
          production: release.track === 'production',
          riskNotes: [
            `This serves the release to ${complete ? 'every user' : `${Math.round(wanted * 100)}% of users`} on the ${release.track} track. Agentship never raises a rollout by itself: this action exists because the manifest asks for it.`,
          ],
        },
      ];
    },
  };
}

/**
 * `google/promote` — the same version code, on a different track.
 *
 * A promotion is not a new build: Play serves the artifact that is already there. So the
 * differ converges on "the target track serves this version code", and a production
 * promotion carries the production flag, which forces an approval whatever the capability
 * table says.
 */
export function googlePromoteDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'promote',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      const from = release.promoteFrom;
      if (from === undefined) return [];

      const source = input.state.tracks.find((candidate) => candidate.track === from);
      const target = input.state.tracks.find((candidate) => candidate.track === release.track);
      const versionCode =
        release.buildNumber !== undefined && !isNeedsInput(release.buildNumber)
          ? release.buildNumber
          : source?.buildNumbers[0];

      if (versionCode === undefined) {
        return [
          {
            kind: 'promote_release',
            target: 'promote',
            operation: 'distributeToTesters',
            summary: `Promote a build from ${from} to ${release.track}`,
            diff: [
              {
                path: `tracks.${release.track}.buildNumbers`,
                after: 'unknown',
                note: `The ${from} track serves nothing, and the manifest names no build number.`,
              },
            ],
            needsInput: ['release.buildNumber'],
          },
        ];
      }
      if (target?.buildNumbers.includes(versionCode) === true) return [];
      if (source !== undefined && !source.buildNumbers.includes(versionCode)) {
        return [
          {
            kind: 'promote_release',
            target: 'promote',
            operation: 'distributeToTesters',
            summary: `Version code ${versionCode} is not on the ${from} track, so it cannot be promoted from it`,
            diff: [
              {
                path: `tracks.${from}.buildNumbers`,
                before: source.buildNumbers.join(', ') || 'none',
                after: versionCode,
              },
            ],
            needsInput: ['release.promoteFrom'],
          },
        ];
      }

      const production = release.track === 'production';
      return [
        {
          kind: 'promote_release',
          target: 'promote',
          operation: 'distributeToTesters',
          summary: `Promote version code ${versionCode} from ${from} to ${release.track}${release.rollout === undefined ? '' : ` at ${Math.round(release.rollout * 100)}%`}`,
          diff: [
            {
              path: `tracks.${release.track}.buildNumbers`,
              before: target === undefined ? 'none' : target.buildNumbers.join(', ') || 'none',
              after: versionCode,
              note: 'Play serves the artifact that is already uploaded; nothing is rebuilt or re-uploaded.',
            },
          ],
          dependsOn: [...editGroupDependencies('promote_release', versionCode)],
          op: {
            op: 'distribute_to_testers',
            buildNumber: versionCode,
            groups: [],
            track: release.track,
            ...(release.rollout === undefined ? {} : { userFraction: release.rollout }),
          },
          production,
          riskNotes: production
            ? [
                'Promoting to production makes this build available to every Google Play user of the app.',
              ]
            : [`This serves the build to the ${release.track} track.`],
        },
      ];
    },
  };
}
