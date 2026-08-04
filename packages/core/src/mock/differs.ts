import type { ActionDraft, DiffEntry, DifferInput, ResourceDiffer } from '../kernel/differ.js';
import { isNeedsInput } from '../kernel/manifest.js';
import type { PendingVerifier } from '../kernel/pending.js';
import type { LocalizedMetadata } from '../store-ops.js';
import type { Store } from '../types.js';
import { MOCK_APP_PRIVACY_CHECK, MOCK_CONTENT_RATING_CHECK } from './mock-adapter.js';

/**
 * The two reference differs of the vertical slice.
 *
 * They are written the way plan-05/06 differs should be: read the manifest, read the
 * snapshot, emit drafts for the difference — nothing else. No classification (the kernel
 * does it from capabilities and policy), no ids, no journaling, no store calls.
 */
const METADATA_FIELDS = [
  'name',
  'subtitle',
  'shortDescription',
  'description',
  'keywords',
  'whatsNew',
  'promotionalText',
  'marketingUrl',
  'supportUrl',
  'privacyPolicyUrl',
  'videoUrl',
] as const;

type MetadataField = (typeof METADATA_FIELDS)[number];

/** Diffs manifest listing text against the store's localizations. */
export function metadataDiffer(store: Store): ResourceDiffer {
  return {
    store,
    resource: 'metadata',
    plan(input: DifferInput): readonly ActionDraft[] {
      const diff: DiffEntry[] = [];
      const needsInput: string[] = [];
      const locales: LocalizedMetadata[] = [];

      // Sorted so drafts (and therefore ids) never depend on manifest key order.
      const entries = Object.entries(input.manifest.metadata.locales).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      for (const [locale, desired] of entries) {
        const remote = input.state.localizations.find((candidate) => candidate.locale === locale);
        const changes: Record<string, string> = {};
        for (const field of METADATA_FIELDS) {
          const value = desired[field];
          if (value === undefined) continue;
          if (isNeedsInput(value)) {
            needsInput.push(`metadata.locales.${locale}.${field}`);
            continue;
          }
          const current = remote?.[field as MetadataField];
          if (current !== value) {
            changes[field] = value;
            diff.push({
              path: `metadata.${locale}.${field}`,
              ...(current === undefined ? {} : { before: current }),
              after: value,
            });
          }
        }
        if (Object.keys(changes).length > 0) locales.push({ locale, ...changes });
      }

      if (diff.length === 0 && needsInput.length === 0) return [];
      const fieldCount = diff.length;
      return [
        {
          kind: 'set_metadata',
          target: 'listing',
          operation: 'setMetadata',
          summary: `Update listing text (${fieldCount} field${fieldCount === 1 ? '' : 's'} across ${locales.length || 1} locale(s))`,
          diff,
          ...(needsInput.length > 0
            ? { needsInput }
            : {
                op: {
                  op: 'set_metadata',
                  changes: { locales, version: input.manifest.release.version },
                },
              }),
        },
      ];
    },
  };
}

/** States in which a version has already been handed to the store for the release. */
const SUBMITTED_STATES = new Set([
  'waiting_review',
  'in_review',
  'pending_release',
  'phased_release',
  'live',
]);

/**
 * Diffs the desired release (build + review submission) against the store.
 *
 * Demonstrates the three couplings later differs will need: an action depending on
 * another action (`submit` needs `upload`), an action blocked by a pending operation
 * (Google review needs the console-only content rating), and a non-idempotent operation
 * (`upload_build`) whose absence from a replan is what proves it already happened.
 */
export function releaseDiffer(store: Store): ResourceDiffer {
  return {
    store,
    resource: 'release',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      const drafts: ActionDraft[] = [];
      const needsInput: string[] = [];
      if (isNeedsInput(release.version)) needsInput.push('release.version');

      const buildNumber = release.buildNumber;
      const artifact = release.artifacts?.[store];
      let uploadDrafted = false;

      if (buildNumber !== undefined && !isNeedsInput(buildNumber)) {
        const existing = input.state.builds.find(
          (candidate) => candidate.buildNumber === buildNumber,
        );
        if (existing === undefined) {
          const uploadNeeds = [...needsInput];
          if (artifact === undefined) uploadNeeds.push(`release.artifacts.${store}`);
          drafts.push({
            kind: 'upload_build',
            target: `build/${buildNumber}`,
            operation: 'uploadBuild',
            summary: `Upload build ${buildNumber} (${release.version})`,
            diff: [{ path: `builds.${buildNumber}`, after: release.version }],
            ...(uploadNeeds.length > 0
              ? { needsInput: uploadNeeds }
              : {
                  op: {
                    op: 'upload_build',
                    artifact: {
                      path: (artifact as { path: string }).path,
                      kind: (artifact as { kind: 'ipa' | 'pkg' | 'aab' | 'apk' }).kind,
                      version: release.version,
                      buildNumber,
                    },
                  },
                }),
          });
          uploadDrafted = true;
        }
      }

      const submitted = input.state.versions.some(
        (version) => version.version === release.version && SUBMITTED_STATES.has(version.state),
      );
      if (!submitted) {
        const contentRating = input.state.pending.find(
          (pending) => pending.category === 'content_rating',
        );
        const submitNeeds = [...needsInput];
        if (buildNumber === undefined || isNeedsInput(buildNumber)) {
          submitNeeds.push('release.buildNumber');
        }
        const current = input.state.versions.find((version) => version.version === release.version);
        drafts.push({
          kind: 'submit_for_review',
          target: `release/${release.version}`,
          operation: 'submitForReview',
          summary: `Submit version ${release.version} (build ${buildNumber ?? '?'}) to ${release.track}`,
          diff: [
            {
              path: `versions.${release.version}.state`,
              before: current?.state ?? 'absent',
              after: 'waiting_review',
            },
          ],
          ...(submitNeeds.length > 0
            ? { needsInput: submitNeeds }
            : {
                op: {
                  op: 'submit_for_review',
                  submission: {
                    version: release.version,
                    buildNumber: buildNumber as string,
                    track: release.track,
                  },
                },
              }),
          ...(uploadDrafted
            ? { dependsOn: [{ kind: 'upload_build', target: `build/${buildNumber}` }] }
            : {}),
          ...(contentRating === undefined ? {} : { blockedBy: [contentRating.id] }),
          production: release.track === 'production',
          riskNotes:
            release.track === 'production'
              ? ['This submission targets production and will reach end users once approved.']
              : [],
        });
      }

      return drafts;
    },
  };
}

/** Verifiers for the console work the mock stores report as outstanding. */
export const mockVerifiers: ReadonlyMap<string, PendingVerifier> = new Map<string, PendingVerifier>(
  [
    [
      MOCK_CONTENT_RATING_CHECK,
      (_operation, state) =>
        !state.pending.some((pending) => pending.category === 'content_rating'),
    ],
    [
      MOCK_APP_PRIVACY_CHECK,
      (_operation, state) => !state.pending.some((pending) => pending.category === 'privacy'),
    ],
  ],
);
