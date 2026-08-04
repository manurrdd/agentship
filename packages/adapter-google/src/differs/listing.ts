import type {
  ActionDraft,
  DiffEntry,
  DifferInput,
  LocalizedMetadata,
  ResourceDiffer,
} from '@agentship/core';
import {
  compareImageSet,
  findRemoteSet,
  isNeedsInput,
  resolveScreenshotSets,
} from '@agentship/core';
import { editGroupDependencies, monetizationDependencies } from './edit-grouping.js';

/**
 * `google/listing` — the store listing text, and `google/images` — its images.
 *
 * Play's listing is app-level, not version-level: what is written here is what every user
 * sees on the store page, for as long as it stands. There is no draft to preview and no
 * version to attach it to, which is why a listing change on a published app is a change to
 * live content.
 *
 * The one trap worth naming: `gpc listings push` reads a directory of files and pushes all
 * of them, treating a missing file as an empty string. Sending only the fields that changed
 * would therefore *blank* the app's description. The adapter merges the current listing
 * underneath — this differ's job is only to say what should differ.
 */
const LISTING_FIELDS = ['name', 'shortDescription', 'description', 'videoUrl'] as const;

export function googleListingDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'listing',
    plan(input: DifferInput): readonly ActionDraft[] {
      const diff: DiffEntry[] = [];
      const needsInput: string[] = [];
      const locales: LocalizedMetadata[] = [];
      let touchesLiveListing = false;

      const entries = Object.entries(input.manifest.metadata.locales).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      for (const [locale, desired] of entries) {
        const remote = input.state.localizations.find((candidate) => candidate.locale === locale);
        const changes: Record<string, string> = {};
        for (const field of LISTING_FIELDS) {
          const value = (desired as Record<string, string | undefined>)[field];
          if (value === undefined) continue;
          if (isNeedsInput(value)) {
            needsInput.push(`metadata.locales.${locale}.${field}`);
            continue;
          }
          const current = (remote as Record<string, string | undefined> | undefined)?.[field];
          if (current === value) continue;
          if (current !== undefined) touchesLiveListing = true;
          changes[field] = value;
          diff.push({
            path: `listing.${locale}.${field}`,
            ...(current === undefined ? {} : { before: current }),
            after: value,
          });
        }

        for (const unsupported of ['subtitle', 'keywords', 'promotionalText'] as const) {
          if ((desired as Record<string, string | undefined>)[unsupported] !== undefined) {
            diff.push({
              path: `listing.${locale}.${unsupported}`,
              note: 'Google Play has no such field; Agentship will not send it.',
            });
          }
        }
        if (Object.keys(changes).length > 0) locales.push({ locale, ...changes });
      }

      if (locales.length === 0 && needsInput.length === 0) return [];
      const fields = diff.filter((entry) => entry.after !== undefined).length;
      return [
        {
          kind: 'set_metadata',
          target: 'listing',
          operation: 'setMetadata',
          summary: `Update the Play listing (${fields} field${fields === 1 ? '' : 's'} across ${locales.length || 1} locale(s))`,
          diff,
          dependsOn: [
            ...editGroupDependencies('set_metadata'),
            ...monetizationDependencies(input.manifest),
          ],
          ...(needsInput.length > 0
            ? { needsInput }
            : { op: { op: 'set_metadata', changes: { locales } } }),
          ...(touchesLiveListing
            ? {
                riskNotes: [
                  'The Play listing is app-level: this text replaces what users see on the store page as soon as the edit is committed and reviewed.',
                ],
              }
            : {}),
        },
      ];
    },
  };
}

/**
 * `google/images` — idempotent by SHA-256.
 *
 * Play reports a SHA-256 for every published image, so unlike Apple the comparison here is
 * exact: a set that already matches produces no action at all, and a resumed plan uploads
 * nothing it already uploaded.
 */
export function googleImagesDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'images',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const assets = input.manifest.assets;
      const sets = assets?.screenshots ?? [];
      if (sets.length === 0) return [];

      const prune = assets?.prune === true;
      const resolved = await resolveScreenshotSets(input.repoRoot, sets);
      const diff: DiffEntry[] = [];
      const changed = [];

      for (const set of resolved) {
        const remote = findRemoteSet(input.state.images, set);
        const comparison = compareImageSet(set, remote, prune);
        if (comparison.matches) continue;
        changed.push(set);
        diff.push({
          path: `images.${set.locale}.${set.slot ?? 'screenshots'}.${set.device}`,
          before: remote === undefined ? 'none' : `${remote.images.length} image(s)`,
          after: `${set.assets.length} image(s)`,
          note: comparison.detail,
        });
      }
      if (changed.length === 0) return [];

      return [
        {
          kind: 'sync_screenshots',
          target: 'images',
          operation: 'syncScreenshots',
          summary: `Sync ${changed.length} Play image set(s)${prune ? ', removing what is not listed' : ''}`,
          diff,
          dependsOn: [
            ...editGroupDependencies('sync_screenshots'),
            ...monetizationDependencies(input.manifest),
          ],
          op: {
            op: 'sync_screenshots',
            plan: {
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
                  'Pruning deletes published images the manifest does not list. Play does not undo that.',
                ],
              }
            : {}),
        },
      ];
    },
  };
}
