import { pendingOf, renderPending } from '@agentship/catalog';
import type { ActionDraft, DifferInput, PendingOperation, ResourceDiffer } from '@agentship/core';

/**
 * `apple/phased-release` and `apple/release` — what happens after approval.
 *
 * Two different things that look alike:
 *
 * **Phased release** is a real API. `versions phased-release create/update` starts, pauses,
 * resumes and completes Apple's seven-day rollout, and Agentship drives it — but never on its
 * own initiative. Apple advances the percentage by itself, one day at a time; the only
 * things a tool should do are start it, and honour an explicit instruction to pause or
 * complete. So this differ converges on the *state* asked for in the manifest and never on a
 * percentage it invented.
 *
 * **Releasing a version held for manual release** is not. It goes through
 * `appStoreVersionReleaseRequests`, which the pinned `asc` does not expose, and Agentship will
 * not invent a command for someone's App Store account. It is emitted as console work with
 * the exact button named — the honest answer, and the reason `releaseVersion` is
 * `agent_browser` in the capability table.
 */
export function applePhasedReleaseDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'rollout',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      if (release.phased !== true) {
        // Not asked for. An active rollout is left alone: stopping one is a decision.
        return [];
      }

      const current = input.state.phasedRelease;
      const version = input.state.versions.find(
        (candidate) => candidate.version === release.version,
      );
      // A phased release only exists once the version is approved; before that there is
      // nothing to configure, and Apple rejects the call.
      if (
        version === undefined ||
        !['pending_release', 'phased_release', 'live'].includes(version.state)
      ) {
        return [];
      }
      if (current !== undefined && current.state === 'active') return [];
      if (current !== undefined && current.state === 'complete') return [];

      return [
        {
          kind: 'set_phased_release',
          target: `phased/${release.version}`,
          operation: 'setPhasedRelease',
          summary: `Start the phased release of ${release.version}`,
          diff: [
            {
              path: `phasedRelease.${release.version}.state`,
              before: current?.state ?? 'inactive',
              after: 'active',
              note: 'Apple raises the percentage itself, one step per day. Agentship never advances it.',
            },
          ],
          op: {
            op: 'set_phased_release',
            action: { action: 'start', track: 'production', versionId: version.id },
          },
          production: true,
          riskNotes: [
            'A phased release reaches real users, starting at 1% and rising daily until 100%.',
          ],
        },
      ];
    },
  };
}

/** The console step for releasing an approved version Apple is holding. */
export function manualReleasePending(version: string): PendingOperation {
  return pendingOf(
    renderPending('apple:release-version', { context: { 'release.version': version } }),
  );
}

/**
 * `apple/release` — surfaces the manual release step for a version Apple is holding.
 *
 * Emitted as an action so it appears in the plan with everything else, classified
 * `agent_browser` by the capability table, which makes the kernel turn it into the pending
 * operation above rather than an attempted call.
 */
export function appleReleaseDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'release',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      if (release.track !== 'production') return [];
      const version = input.state.versions.find(
        (candidate) => candidate.version === release.version,
      );
      if (version === undefined || version.state !== 'pending_release') return [];

      return [
        {
          kind: 'release_version',
          target: `release/${release.version}`,
          operation: 'releaseVersion',
          summary: `Release the approved version ${release.version} to the App Store`,
          diff: [
            {
              path: `versions.${release.version}.state`,
              before: 'pending_release',
              after: 'live',
            },
          ],
          pending: manualReleasePending(release.version),
          production: true,
          riskNotes: [
            'This makes the version visible to every App Store customer. Apple approved it; the timing is the user’s decision.',
          ],
        },
      ];
    },
  };
}
