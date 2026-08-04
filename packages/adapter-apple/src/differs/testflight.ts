import type {
  ActionDraft,
  DiffEntry,
  DifferInput,
  ResourceDiffer,
  TesterGroupSpec,
} from '@agentship/core';
import { isNeedsInput } from '@agentship/core';

/**
 * `apple/testflight` — tester groups, their members, and which build they get.
 *
 * TestFlight is where a release should be tried before the App Store, so this differ is
 * deliberately the most permissive one: creating a group and adding members is reversible
 * and invisible to the public, and the capability table classifies it `auto`. Distributing a
 * build to testers is not — it sends real e-mail to real people — so that one is
 * `needs_approval`.
 *
 * Members are only ever added, never removed, unless the manifest asks for it. Silently
 * dropping a tester because someone forgot to list them is the kind of quiet destruction
 * this engine exists to avoid.
 */
const TESTFLIGHT_TRACKS = new Set(['internal_testing', 'closed_testing', 'open_testing']);

export function appleTestFlightDiffer(): ResourceDiffer {
  return {
    store: 'apple',
    resource: 'testflight',
    plan(input: DifferInput): readonly ActionDraft[] {
      const release = input.manifest.release;
      const groups = input.manifest.testers?.groups ?? [];
      const drafts: ActionDraft[] = [];

      const wanted = groups.filter((group) => TESTFLIGHT_TRACKS.has(group.track));
      const groupDiff: DiffEntry[] = [];
      const specs: TesterGroupSpec[] = [];

      for (const group of [...wanted].sort((a, b) => a.name.localeCompare(b.name))) {
        const remote = input.state.testerGroups.find((candidate) => candidate.name === group.name);
        const members = (group.members ?? []).filter((member) => !isNeedsInput(member));
        const missing =
          remote === undefined
            ? members
            : members.filter((member) => !remote.members.includes(member));
        const needsPublicLink =
          group.publicLink === true && remote !== undefined && remote.publicLink === undefined;

        if (remote !== undefined && missing.length === 0 && !needsPublicLink) continue;
        specs.push({
          name: group.name,
          track: group.track,
          ...(members.length === 0 ? {} : { members }),
          ...(group.publicLink === undefined ? {} : { publicLink: group.publicLink }),
        });
        groupDiff.push({
          path: `testflight.groups.${group.name}`,
          before: remote === undefined ? 'absent' : `${remote.members.length} tester(s)`,
          after:
            remote === undefined
              ? `new group with ${members.length} tester(s)`
              : `${remote.members.length + missing.length} tester(s)`,
        });
      }

      if (specs.length > 0) {
        drafts.push({
          kind: 'manage_tester_groups',
          target: 'groups',
          operation: 'manageTesterGroups',
          summary: `Create or update ${specs.length} TestFlight group(s)`,
          diff: groupDiff,
          op: { op: 'manage_tester_groups', changes: { groups: specs } },
        });
      }

      // Distribution only makes sense when the release targets a TestFlight track and the
      // build number is known; production releases go through the review submission instead.
      const buildNumber = release.buildNumber;
      if (
        !TESTFLIGHT_TRACKS.has(release.track) ||
        buildNumber === undefined ||
        isNeedsInput(buildNumber) ||
        wanted.length === 0
      ) {
        return drafts;
      }

      const targetGroups = wanted
        .filter((group) => group.track === release.track)
        .map((group) => group.name)
        .sort();
      if (targetGroups.length === 0) return drafts;

      // Nothing observable says "this build reached this group" beyond the build existing and
      // the group existing, so the differ converges on the build being present *and* already
      // valid: a processing build cannot be distributed, and re-running is harmless.
      const build = input.state.builds.find((candidate) => candidate.buildNumber === buildNumber);
      if (build !== undefined && build.state === 'processing') return drafts;

      drafts.push({
        kind: 'distribute_to_testers',
        target: `build/${buildNumber}`,
        operation: 'distributeToTesters',
        summary: `Give build ${buildNumber} to ${targetGroups.join(', ')} on TestFlight`,
        diff: [
          {
            path: `testflight.distribution.${buildNumber}`,
            after: targetGroups.join(', '),
            note: 'Testers in these groups are notified by e-mail.',
          },
        ],
        dependsOn: [
          { kind: 'upload_build', target: `build/${buildNumber}`, optional: true },
          { kind: 'manage_tester_groups', target: 'groups', optional: true },
        ],
        op: {
          op: 'distribute_to_testers',
          buildNumber,
          groups: targetGroups,
          track: release.track,
        },
        riskNotes: ['Every tester in these groups receives an e-mail as soon as this runs.'],
      });
      return drafts;
    },
  };
}
