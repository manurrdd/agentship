import { pendingOf, renderPending } from '@agentship/catalog';
import type { ActionDraft, DifferInput, PendingOperation, ResourceDiffer } from '@agentship/core';
import { isNeedsInput } from '@agentship/core';
import {
  explainIllegal,
  findVersion,
  isEditable,
  versionActionLegality,
} from './version-state-rules.js';

/**
 * `apple/version` — the editable App Store version the rest of the release hangs off.
 *
 * Everything version-scoped on Apple (listing text, screenshots, the build attachment, the
 * submission) addresses a version resource that has to exist first. Making that its own
 * action rather than a side effect of the first write has two payoffs: the plan shows the
 * user that a version will be created, and the ordering constraint becomes explicit instead
 * of implicit in whichever write happened to run first.
 *
 * The interesting case is a version that exists but is no longer editable. Agentship refuses
 * to plan around it: a version in review has frozen content, and the only ways forward —
 * wait, or withdraw the submission — are both decisions with real cost. So the action is
 * emitted as `needs_input`, naming both options, and nothing is attempted.
 */
export function appleVersionDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'version',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      if (isNeedsInput(release.version)) {
        return [
          {
            kind: 'ensure_version',
            target: 'version',
            operation: 'ensureVersion',
            summary: 'Create the App Store version once the manifest says which one',
            diff: [{ path: 'release.version', after: '<needs_input>' }],
            needsInput: ['release.version'],
          },
        ];
      }

      const existing = findVersion(input.state.versions, release.version);
      const strategy = release.strategy;
      const scheduledDate = release.scheduledDate;

      if (existing !== undefined && !isEditable(existing.state)) {
        // A frozen version is only a problem when the manifest still wants something from
        // it. Once a version has been handed to App Review and the manifest matches what
        // was submitted, there is nothing to report — saying "this is frozen" every time
        // would turn a finished release into a plan that never empties.
        if (!wantsContentChange(input)) return [];
        const legality = versionActionLegality('set_metadata', existing.state);
        // Frozen *and* asked to change: say what the state is, what the two ways out cost,
        // and stop.
        return [
          {
            kind: 'ensure_version',
            target: 'version',
            operation: 'ensureVersion',
            summary: `Version ${release.version} exists but is ${existing.state}; it cannot be edited`,
            diff: [
              {
                path: `versions.${release.version}.state`,
                before: existing.state,
                after: 'editable',
                note: explainIllegal('set_metadata', existing, legality),
              },
            ],
            needsInput: ['release.version'],
            riskNotes: [
              explainIllegal('set_metadata', existing, legality),
              'Agentship will not withdraw a submission: that decision, and the review queue it costs, belongs to a human.',
            ],
          },
        ];
      }

      const wantsStrategy =
        existing !== undefined && existing.releaseStrategy !== strategy ? strategy : undefined;
      if (existing !== undefined && wantsStrategy === undefined) return [];

      const diff = [
        existing === undefined
          ? { path: `versions.${release.version}`, after: 'draft' }
          : {
              path: `versions.${release.version}.releaseStrategy`,
              before: existing.releaseStrategy ?? 'unset',
              after: strategy,
            },
      ];
      return [
        {
          kind: 'ensure_version',
          target: 'version',
          operation: 'ensureVersion',
          summary:
            existing === undefined
              ? `Create App Store version ${release.version} (release: ${strategy})`
              : `Set version ${release.version} to release ${strategy}`,
          diff,
          op: {
            op: 'ensure_version',
            spec: {
              version: release.version,
              platform: 'ios',
              releaseStrategy: strategy,
              ...(strategy === 'scheduled' && scheduledDate !== undefined
                ? { scheduledReleaseDate: scheduledDate }
                : {}),
            },
          },
        },
      ];
    },
  };
}

/**
 * Whether the manifest still asks for listing text the store does not hold.
 *
 * Deliberately the same comparison the metadata differ makes, restricted to the fields
 * Agentship can write: the question "is this version frozen in a way that matters?" only has
 * an answer relative to what the user is asking for.
 */
const COMPARABLE_FIELDS = [
  'name',
  'subtitle',
  'description',
  'keywords',
  'whatsNew',
  'promotionalText',
  'marketingUrl',
  'supportUrl',
  'privacyPolicyUrl',
] as const;

function wantsContentChange(input: DifferInput): boolean {
  for (const [locale, desired] of Object.entries(input.manifest.metadata.locales)) {
    const remote = input.state.localizations.filter((candidate) => candidate.locale === locale);
    for (const field of COMPARABLE_FIELDS) {
      const value = (desired as Record<string, string | undefined>)[field];
      if (value === undefined || isNeedsInput(value)) continue;
      const held = remote.some(
        (candidate) =>
          (candidate as unknown as Record<string, string | undefined>)[field] === value,
      );
      if (!held) return true;
    }
  }
  return false;
}

/**
 * The pending operation a rejected version turns into: read the reviewer, then iterate.
 *
 * The instructions, the console path and the verification all come from the catalog entry
 * `apple:resolution-center`; what the differ adds is the one thing the catalog cannot know —
 * which version this is about, and what the reviewer actually said.
 */
export function resolutionCenterPending(
  version: string,
  messages: readonly string[],
): PendingOperation {
  return pendingOf(
    renderPending('apple:resolution-center', {
      context: { 'release.version': version },
      ...(messages.length === 0 ? {} : { extraNotes: messages.join('\n') }),
    }),
  );
}
