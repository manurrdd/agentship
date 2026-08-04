import type { ActionDraft, DiffEntry, DifferInput, ResourceDiffer } from '@agentship/core';
import { compareImageSet, findRemoteSet, resolveScreenshotSets } from '@agentship/core';
import { findVersion, isSubmitted } from './version-state-rules.js';

/**
 * `apple/screenshots` — a declarative image sync.
 *
 * Idempotence comes from hashing: the manifest's files are hashed locally and compared with
 * what the store reports, and a set that already matches produces no action at all. On Apple
 * the comparison is weaker than on Google — App Store Connect reports the MD5 it computed at
 * upload, not a SHA-256 — so when hashes are unavailable Agentship compares how many images
 * each set holds and says so in the diff. `asc screenshots upload --skip-existing` does the
 * exact comparison on the store side, so a redundant sync still uploads nothing; what the
 * weaker local comparison costs is only the ability to *plan* around it.
 *
 * Pruning is opt-in and is treated as destructive, because deleting a published screenshot
 * cannot be undone: the file has to be uploaded again, and the order re-established.
 */
export function appleScreenshotsDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'screenshots',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const assets = input.manifest.assets;
      const sets = assets?.screenshots ?? [];
      if (sets.length === 0) return [];

      const release = input.manifest.release;
      const target = findVersion(input.state.versions, release.version);
      if (target !== undefined && isSubmitted(target.state)) return [];

      const prune = assets?.prune === true;
      const resolved = await resolveScreenshotSets(input.repoRoot, sets);
      const diff: DiffEntry[] = [];
      const changed = [];
      let approximate = false;

      for (const set of resolved) {
        const remote = findRemoteSet(input.state.images, set);
        const comparison = compareImageSet(set, remote, prune);
        if (comparison.byCountOnly) approximate = true;
        if (comparison.matches) continue;
        changed.push(set);
        diff.push({
          path: `screenshots.${set.locale}.${set.device}`,
          before: remote === undefined ? 'none' : `${remote.images.length} image(s)`,
          after: `${set.assets.length} image(s)`,
          note: comparison.detail,
        });
      }

      if (changed.length === 0) return [];
      return [
        {
          kind: 'sync_screenshots',
          target: 'screenshots',
          operation: 'syncScreenshots',
          summary: `Sync ${changed.length} screenshot set(s) for ${release.version}${prune ? ', removing what is not listed' : ''}`,
          diff,
          dependsOn: [
            { kind: 'ensure_version', target: 'version', optional: true },
            // App Store Connect attaches screenshots to a version *localization*, so the
            // locale's text has to exist before its images can.
            { kind: 'set_metadata', target: 'listing', optional: true },
          ],
          op: {
            op: 'sync_screenshots',
            plan: {
              version: release.version,
              sets: changed.map((set) => ({
                locale: set.locale,
                device: set.device,
                ...(set.slot === undefined ? {} : { slot: set.slot }),
                assets: set.assets,
              })),
              ...(prune ? { prune: true } : {}),
            },
          },
          ...(prune
            ? {
                destructive: true,
                riskNotes: [
                  'Pruning deletes published screenshots that the manifest does not list. Deletion is irreversible: the images would have to be uploaded and reordered again.',
                ],
              }
            : {}),
          ...(approximate
            ? {
                riskNotes: [
                  'App Store Connect does not report a comparable hash for published screenshots, so Agentship compared set sizes. The upload itself skips images the store already has.',
                ],
              }
            : {}),
        },
      ];
    },
  };
}
