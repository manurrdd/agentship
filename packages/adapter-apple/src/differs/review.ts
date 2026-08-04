import type { ActionDraft, DifferInput, PendingOperation, ResourceDiffer } from '@agentship/core';
import { isNeedsInput } from '@agentship/core';
import { resolutionCenterPending } from './version.js';
import {
  explainIllegal,
  findVersion,
  isSubmitted,
  versionActionLegality,
} from './version-state-rules.js';

/**
 * `apple/review-submission` — the one action that hands the app to Apple.
 *
 * Always `needs_approval`, on both counts the policy recognises: `submitForReview` is a
 * sensitive operation, and a production submission is `production`. Neither classification
 * can be relaxed by a capability table.
 *
 * The differ's real job is knowing when *not* to draft it. A version already in review must
 * not be resubmitted (App Store Connect answers with a conflict, and a retry loop would keep
 * hitting it), a rejected version needs a human to read the reviewer first, and a production
 * submission with no build attached would be rejected within the hour. Each of those becomes
 * a blocked action or a pending operation with the console step spelled out, never an
 * attempt.
 */
export function appleReviewDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'review',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      // TestFlight distribution is not an App Store submission; that track never submits.
      if (release.track !== 'production') return [];
      if (isNeedsInput(release.version)) return [];

      const version = findVersion(input.state.versions, release.version);
      if (version !== undefined && isSubmitted(version.state)) return [];

      const buildNumber = release.buildNumber;
      const needsInput: string[] = [];
      if (buildNumber === undefined || isNeedsInput(buildNumber)) {
        needsInput.push('release.buildNumber');
      }

      const blockedBy: string[] = [];
      const pendings: PendingOperation[] = [];

      if (version !== undefined && version.state === 'rejected') {
        // Iterating after a rejection is legal, but only once a human has read why.
        const pending = resolutionCenterPending(release.version, []);
        pendings.push(pending);
        blockedBy.push(pending.id);
      }

      // App Privacy is a legal declaration with no API; Apple refuses the submission without
      // it, so the plan gates on it instead of discovering it at submission time.
      const privacy = input.state.pending.find((operation) => operation.category === 'privacy');
      if (privacy !== undefined) blockedBy.push(privacy.id);

      const review = input.manifest.review;
      const demoIncomplete =
        review?.demoAccountRequired === true &&
        (review.demoAccountName === undefined || review.demoAccountProfile === undefined);
      if (demoIncomplete) {
        needsInput.push('review.demoAccountName', 'review.demoAccountProfile');
      }

      const legality =
        version === undefined
          ? { legal: true }
          : versionActionLegality('submit_for_review', version.state);

      return [
        {
          kind: 'submit_for_review',
          target: `release/${release.version}`,
          operation: 'submitForReview',
          summary: `Submit ${release.version} (build ${buildNumber ?? '?'}) to App Review`,
          diff: [
            {
              path: `versions.${release.version}.state`,
              before: version?.state ?? 'absent',
              after: 'waiting_review',
              ...(review?.notes === undefined
                ? {}
                : { note: `Review notes: ${review.notes.slice(0, 200)}` }),
            },
          ],
          dependsOn: [
            { kind: 'ensure_version', target: 'version', optional: true },
            { kind: 'set_metadata', target: 'listing', optional: true },
            { kind: 'sync_screenshots', target: 'screenshots', optional: true },
            { kind: 'upload_build', target: `build/${buildNumber ?? 'unknown'}`, optional: true },
          ],
          ...(blockedBy.length === 0 ? {} : { blockedBy }),
          ...(pendings.length === 0 ? {} : { pending: pendings[0] }),
          ...(needsInput.length > 0
            ? { needsInput }
            : {
                op: {
                  op: 'submit_for_review',
                  submission: {
                    version: release.version,
                    buildNumber: buildNumber as string,
                    track: 'production',
                    holdForDeveloperRelease: release.strategy === 'manual',
                  },
                },
              }),
          production: true,
          riskNotes: [
            'This hands the app to App Review. Once submitted, the version’s content is frozen until the review finishes.',
            ...(release.strategy === 'manual'
              ? [
                  'The approved version will wait for a manual release rather than going live automatically.',
                ]
              : ['The version goes live automatically as soon as it is approved.']),
            ...(legality.legal || version === undefined
              ? []
              : [explainIllegal('submit_for_review', version, legality)]),
          ],
        },
      ];
    },
  };
}
