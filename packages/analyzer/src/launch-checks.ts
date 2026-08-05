import type { DetectedSdk, LaunchCheck } from '@agentship/core';
import { loadCoreLaunchChecks } from './catalog.js';
import { catalogEntriesFor } from './sdks.js';

/**
 * Everything a launch might need that lives outside the stores.
 *
 * The agent driving Agentship knows *how* to publish a legal page or configure a backend;
 * what it forgets is *that* it might have to. These checks are that reminder, as data:
 * a constant core every app gets, plus whatever the detected SDKs make necessary — so a
 * project only ever sees the checks that apply to it.
 *
 * They are deliberately not warnings and not gates. Agentship neither performs nor
 * verifies them; the agent walks them with the user, and dismissing one with a reason is
 * a valid outcome.
 */
export function deriveLaunchChecks(sdks: readonly DetectedSdk[]): LaunchCheck[] {
  const core = loadCoreLaunchChecks().map((check) => ({ ...check, source: 'core' }));
  const fromSdks = catalogEntriesFor(sdks.map((sdk) => sdk.id)).flatMap((entry) =>
    (entry.launchChecks ?? []).map((check) => ({
      id: `${entry.id}:${check.id}`,
      claim: check.claim,
      source: entry.id,
    })),
  );
  return [...core, ...fromSdks];
}
