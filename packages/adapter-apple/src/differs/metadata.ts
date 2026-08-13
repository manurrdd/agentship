import type {
  ActionDraft,
  DiffEntry,
  DifferInput,
  LocalizedMetadata,
  ResourceDiffer,
} from '@agentship/core';
import { equivalentStoreText, isNeedsInput } from '@agentship/core';
import { findVersion, isSubmitted } from './version-state-rules.js';

/**
 * `apple/metadata` — the listing text, field by field and locale by locale.
 *
 * Two properties matter more than the diffing itself.
 *
 * **Only what changed travels.** A field the store already holds is not re-sent, so a
 * replan after a partial apply naturally shrinks, and a resume converges instead of
 * rewriting everything.
 *
 * **The app name is treated as live content.** `name` is not version-scoped on Apple: it
 * appears on the App Store the moment it is approved, and on an app that is already
 * published a rename is visible to every existing user. So changing the name of a live app
 * is forced to `needs_approval` even though the rest of the listing text for a draft version
 * is not — that is the `destructive` flag doing its job.
 */
const VERSION_FIELDS = [
  'description',
  'keywords',
  'whatsNew',
  'promotionalText',
  'marketingUrl',
  'supportUrl',
] as const;

/** App-level text: not scoped to a version, so it reaches users as soon as it is approved. */
const APP_FIELDS = ['name', 'subtitle', 'privacyPolicyUrl'] as const;

type Field = (typeof VERSION_FIELDS)[number] | (typeof APP_FIELDS)[number];

export function appleMetadataDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'metadata',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      const diff: DiffEntry[] = [];
      const needsInput: string[] = [];
      const locales: LocalizedMetadata[] = [];
      let renamesLiveApp = false;

      const appIsLive = input.state.versions.some(
        (version) => version.state === 'live' || version.state === 'phased_release',
      );

      const entries = Object.entries(input.manifest.metadata.locales).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      for (const [locale, desired] of entries) {
        // App-level text has no versionId; version text belongs to the release's version.
        const appLevel = input.state.localizations.find(
          (candidate) => candidate.locale === locale && candidate.versionId === undefined,
        );
        const versionLevel = input.state.localizations.find(
          (candidate) => candidate.locale === locale && candidate.versionId !== undefined,
        );
        const changes: Record<string, string> = {};

        for (const field of [...VERSION_FIELDS, ...APP_FIELDS] as readonly Field[]) {
          const value = (desired as Record<string, string | undefined>)[field];
          if (value === undefined) continue;
          if (isNeedsInput(value)) {
            needsInput.push(`metadata.locales.${locale}.${field}`);
            continue;
          }
          const isAppField = (APP_FIELDS as readonly string[]).includes(field);
          const remote = isAppField ? (appLevel ?? versionLevel) : (versionLevel ?? appLevel);
          const current = (remote as Record<string, string | undefined> | undefined)?.[field];
          if (equivalentStoreText(current, value)) continue;
          if (field === 'name' && appIsLive && current !== undefined) renamesLiveApp = true;
          changes[field] = value;
          diff.push({
            path: `metadata.${locale}.${field}`,
            ...(current === undefined ? {} : { before: current }),
            after: value,
          });
        }

        // Fields Agentship knows the App Store has no place for: warn in the diff rather than
        // dropping them silently, and never send them.
        for (const unsupported of ['shortDescription', 'videoUrl'] as const) {
          if ((desired as Record<string, string | undefined>)[unsupported] !== undefined) {
            diff.push({
              path: `metadata.${locale}.${unsupported}`,
              note: 'The App Store has no such field; Agentship will not send it.',
            });
          }
        }

        if (Object.keys(changes).length > 0) locales.push({ locale, ...changes });
      }

      if (locales.length === 0 && needsInput.length === 0) return [];

      const target = findVersion(input.state.versions, release.version);
      if (target !== undefined && isSubmitted(target.state)) {
        // The version's content is frozen; the version differ already explains why.
        return [];
      }

      const fields = diff.filter((entry) => entry.after !== undefined).length;
      return [
        {
          kind: 'set_metadata',
          target: 'listing',
          operation: 'setMetadata',
          summary: `Update listing text for ${release.version} (${fields} field${fields === 1 ? '' : 's'} across ${locales.length || 1} locale(s))`,
          diff,
          dependsOn: [{ kind: 'ensure_version', target: 'version', optional: true }],
          ...(needsInput.length > 0
            ? { needsInput }
            : {
                op: {
                  op: 'set_metadata',
                  changes: {
                    version: release.version,
                    locales,
                    ...(release.strategy === undefined
                      ? {}
                      : { releaseStrategy: release.strategy }),
                  },
                },
              }),
          ...(renamesLiveApp
            ? {
                destructive: true,
                riskNotes: [
                  'This renames an app that is already on the App Store: the new name is what every existing user will see once the version is approved.',
                ],
              }
            : {}),
        },
      ];
    },
  };
}
