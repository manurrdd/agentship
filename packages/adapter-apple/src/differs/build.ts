import type { ActionDraft, DifferInput, ResourceDiffer } from '@agentship/core';
import {
  isNeedsInput,
  plannedArtifactPath,
  resolveArtifactPath,
  usableArtifact,
} from '@agentship/core';

/**
 * `apple/build` — upload the artifact and wait for App Store Connect to finish processing.
 *
 * The only non-idempotent operation in the whole Apple flow: Apple rejects a second upload
 * of the same build number outright. What keeps it safe is not a lock or a flag but the
 * question this differ asks — "does the store already have build N?" — answered against a
 * fresh snapshot every time. After a successful upload the answer is yes, the action
 * disappears from the plan, and no sequence of interruptions can produce a second upload.
 *
 * Processing is part of the upload, not a separate step: `asc builds upload --wait` polls
 * until App Store Connect finishes, and a kill during that wait leaves an orphan intent
 * whose effect *did* land — so the resumed plan simply finds the build present and moves on
 * to attaching it. That is why waiting belongs inside the adapter rather than in a poll loop
 * up here.
 */
export function appleBuildDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'build-upload',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const release = input.manifest.release;
      const buildNumber = release.buildNumber;
      const needsInput: string[] = [];
      if (isNeedsInput(release.version)) needsInput.push('release.version');
      if (buildNumber === undefined || isNeedsInput(buildNumber)) {
        needsInput.push('release.buildNumber');
      }

      if (buildNumber !== undefined && !isNeedsInput(buildNumber)) {
        const existing = input.state.builds.find(
          (candidate) => candidate.buildNumber === buildNumber,
        );
        // Present in any state — including `processing` — means the upload already happened.
        if (existing !== undefined) return [];
      }

      const artifact =
        needsInput.length > 0
          ? undefined
          : await usableArtifact(input.repoRoot, 'apple', {
              version: release.version,
              buildNumber: buildNumber as string,
            });
      const declared = input.manifest.release.artifacts?.apple;

      const whatToTest =
        input.manifest.metadata.locales[input.manifest.metadata.primaryLocale]?.whatsNew;
      // Three ways to know what will be uploaded, in order of certainty: an artifact that
      // exists and hashes correctly; one the manifest points at; or the path the build
      // action in this very plan is going to write. The third is what lets build and upload
      // be two chained actions in one apply instead of two separate runs.
      const path =
        artifact?.path ??
        (declared === undefined
          ? needsInput.length > 0
            ? undefined
            : plannedArtifactPath(
                input.repoRoot,
                'apple',
                'ipa',
                release.version,
                buildNumber as string,
              )
          : resolveArtifactPath(input.repoRoot, declared.path));
      const kind = artifact?.kind ?? declared?.kind ?? 'ipa';

      return [
        {
          kind: 'upload_build',
          target: `build/${buildNumber ?? 'unknown'}`,
          operation: 'uploadBuild',
          summary: `Upload build ${buildNumber ?? '?'} of ${release.version} to App Store Connect and wait for processing`,
          diff: [
            {
              path: `builds.${buildNumber ?? '?'}`,
              after: release.version,
              ...(artifact === undefined
                ? {}
                : { note: `sha256 ${artifact.sha256.slice(0, 12)}…, ${artifact.sizeBytes} bytes` }),
            },
          ],
          dependsOn: [{ kind: 'build', target: `ios/${release.version}`, optional: true }],
          ...(needsInput.length > 0
            ? { needsInput }
            : {
                op: {
                  op: 'upload_build',
                  artifact: {
                    path: path as string,
                    kind: kind as 'ipa' | 'pkg',
                    version: release.version,
                    buildNumber: buildNumber as string,
                    ...(whatToTest === undefined || isNeedsInput(whatToTest) ? {} : { whatToTest }),
                  },
                },
              }),
          riskNotes: [
            'App Store Connect rejects a second upload of the same build number. Agentship only drafts this action when the store shows no such build.',
          ],
        },
      ];
    },
  };
}
