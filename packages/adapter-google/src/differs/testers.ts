import type {
  ActionDraft,
  DiffEntry,
  DifferInput,
  PendingOperation,
  ResourceDiffer,
  TesterGroupSpec,
} from '@agentship/core';
import { isNeedsInput } from '@agentship/core';
import { editGroupDependencies, monetizationDependencies } from './edit-grouping.js';

/**
 * `google/testers` — who gets a testing track.
 *
 * Play models testers in two incompatible ways, and the difference decides what Agentship can
 * automate. A Google Group address on a track is a single API call, so it is `auto`. A list
 * of individual e-mail addresses is not exposed by the Play Developer API at all — it is
 * managed in the console — so those become console work with the addresses laid out, rather
 * than a call that would silently drop half the list.
 *
 * Telling one from the other is mechanical: a Google Group is an address the developer
 * controls as a group, which in practice means the manifest declares it as the group's
 * `name`. Individual testers arrive in `members`.
 */
const GOOGLE_GROUP_ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function googleTestersDiffer(): ResourceDiffer {
  return {
    store: 'google',
    resource: 'testers',
    plan(input: DifferInput): readonly ActionDraft[] {
      const groups = input.manifest.testers?.groups ?? [];
      if (groups.length === 0) return [];

      const specs: TesterGroupSpec[] = [];
      const diff: DiffEntry[] = [];
      const individuals: { track: string; emails: string[] }[] = [];

      for (const group of [...groups].sort((a, b) => a.name.localeCompare(b.name))) {
        if (group.track === 'production') continue;
        const members = (group.members ?? []).filter((member) => !isNeedsInput(member));
        const groupAddresses = GOOGLE_GROUP_ADDRESS.test(group.name) ? [group.name] : [];
        const personal = members.filter((member) => member !== group.name);

        const remote = input.state.testerGroups.find(
          (candidate) => candidate.name === group.name || candidate.track === group.track,
        );
        const missingGroups = groupAddresses.filter(
          (address) => remote === undefined || !remote.members.includes(address),
        );
        if (missingGroups.length > 0) {
          specs.push({ name: group.name, track: group.track, members: missingGroups });
          diff.push({
            path: `testers.${group.track}.groups`,
            before: remote === undefined ? 'none' : remote.members.join(', ') || 'none',
            after: missingGroups.join(', '),
          });
        }
        if (personal.length > 0) {
          const already = remote?.members ?? [];
          const missing = personal.filter((email) => !already.includes(email));
          if (missing.length > 0) individuals.push({ track: group.track, emails: missing });
        }
      }

      const drafts: ActionDraft[] = [];
      if (specs.length > 0) {
        drafts.push({
          kind: 'manage_tester_groups',
          target: 'groups',
          operation: 'manageTesterGroups',
          summary: `Attach ${specs.length} Google Group(s) to their testing track(s)`,
          diff,
          dependsOn: [
            ...editGroupDependencies('manage_tester_groups'),
            ...monetizationDependencies(input.manifest),
          ],
          op: { op: 'manage_tester_groups', changes: { groups: specs } },
        });
      }

      for (const entry of individuals) {
        drafts.push({
          kind: 'add_individual_testers',
          target: `testers/${entry.track}`,
          operation: 'appAvailability',
          summary: `Add ${entry.emails.length} individual tester(s) to the ${entry.track} track`,
          diff: [
            {
              path: `testers.${entry.track}.individuals`,
              after: entry.emails.join(', '),
              note: 'The Play Developer API manages Google Groups on a track, not individual e-mail lists.',
            },
          ],
          pending: individualTestersPending(entry.track, entry.emails),
        });
      }
      return drafts;
    },
  };
}

function individualTestersPending(track: string, emails: readonly string[]): PendingOperation {
  return {
    id: `google:testers-${track}`,
    store: 'google',
    category: 'availability',
    title: `Add individual testers to the ${track} track`,
    reason:
      'The Play Developer API attaches Google Groups to a track; individual e-mail lists are managed only in Play Console.',
    actionClass: 'agent_browser',
    console: {
      url: 'https://play.google.com/console',
      path: ['Testing', '<track>', 'Testers'],
      lastVerified: '2026-08-03',
    },
    steps: [
      `Open the ${track} track's Testers tab.`,
      'Create or edit an e-mail list and paste the addresses below.',
      'Save, and make sure the list is selected for the track.',
    ],
    fields: emails.map((email, index) => ({
      name: `tester${index + 1}`,
      label: 'Tester e-mail',
      required: true,
      proposedValue: email,
    })),
    verification: {
      summary: `The ${track} track lists these testers.`,
      check: 'google:track-testers',
      params: { track },
    },
    status: 'open',
  };
}
