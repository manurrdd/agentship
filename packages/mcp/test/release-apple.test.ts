import { ManifestSchema, saveManifest } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { actionsOf, createMcpHarness, type McpHarness, outcomesOf } from './helpers.js';

/**
 * A whole App Store release, driven through MCP against the mock store.
 *
 * These are the release scenarios that matter, written the way an agent would
 * actually run them: plan, show the diffs, approve by id, apply, and — because applying part
 * of a plan changes the store — plan again against the new ids. Nothing here calls a differ
 * or an adapter directly; if these pass, the conversation works.
 */
function appleManifest(overrides: Record<string, unknown> = {}) {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: { apple: { bundleId: 'com.example.mock', appId: 'app-1' } },
    release: {
      version: '1.1.0',
      buildNumber: '42',
      track: 'production',
      strategy: 'manual',
      artifacts: { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } },
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: 'Mock App',
          description: 'Fresh new description.',
          whatsNew: 'Faster and calmer.',
        },
      },
    },
    testers: {
      groups: [{ name: 'Internal', track: 'internal_testing', members: ['tester@example.com'] }],
    },
    ...overrides,
  });
}

/**
 * Plan → approve every action the plan asks for → apply, repeated until nothing changes.
 *
 * This is the agent loop, compressed: approvals rotate after every apply because executing
 * part of a plan changes the store, so each round re-approves against the fresh ids. It
 * stops when the plan empties or when a round executes nothing, which is what "everything
 * left is withheld on purpose" looks like.
 */
async function driveToConvergence(harness: McpHarness, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as {
      planId: string;
      approvalsRequired: string[];
      actions: unknown[];
    };
    if (plan.actions.length === 0) return;
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    const executed = outcomesOf(applied.payload).some((outcome) => outcome.status === 'done');
    if (!executed) return;
  }
}

describe('Apple: a complete first release', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('creates the version, writes the listing, uploads the build and submits it', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: appleManifest() });
    const apple = harness.adapters.get('apple');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const kinds = actionsOf(planned.payload).map((action) => action.kind);
    expect(kinds).toContain('ensure_version');
    expect(kinds).toContain('set_metadata');
    expect(kinds).toContain('upload_build');
    expect(kinds).toContain('submit_for_review');
    // Ordering is a dependency chain, not luck: the submission runs after everything it
    // needs. Independent work (tester groups) may legitimately sort after it.
    const submitAt = kinds.indexOf('submit_for_review');
    for (const prerequisite of ['ensure_version', 'set_metadata', 'upload_build']) {
      expect(kinds.indexOf(prerequisite)).toBeLessThan(submitAt);
    }

    // The submission is the one action that can never be automatic.
    const submit = actionsOf(planned.payload).find((action) => action.kind === 'submit_for_review');
    expect(submit?.classification).toBe('needs_approval');

    await driveToConvergence(harness);

    expect(apple?.state.versions.find((v) => v.version === '1.1.0')?.state).toBe('waiting_review');
    expect(apple?.effects.uploads).toBe(1);
    expect(apple?.effects.submits).toBe(1);
    const after = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    expect(actionsOf(after.payload)).toHaveLength(0);
  });

  it('never submits without a valid approval, however many times it is applied', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: appleManifest() });
    const apple = harness.adapters.get('apple');

    for (let round = 0; round < 3; round += 1) {
      const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
      const plan = planned.payload['plan'] as { planId: string };
      await harness.call('agentship_apply', { planId: plan.planId });
    }
    expect(apple?.effects.submits).toBe(0);
    expect(apple?.effects.metadataWrites).toBe(0);
    // Everything `auto` still ran: the upload is not approval-gated.
    expect(apple?.effects.uploads).toBe(1);
  });
});

describe('Apple: a rejection, then an iteration', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('blocks the resubmission until a human has read the reviewer, then resubmits', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: appleManifest(),
      state: () => ({
        versions: [{ id: 'v-2', version: '1.1.0', state: 'rejected', track: 'production' }],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
      }),
    });
    const apple = harness.adapters.get('apple');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const submit = actionsOf(planned.payload).find((action) => action.kind === 'submit_for_review');
    expect(submit).toBeDefined();

    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const blocked = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    const outcome = outcomesOf(blocked.payload).find(
      (entry) => entry.actionId === (submit?.id as string),
    );
    expect(outcome?.status).toBe('blocked');
    expect(apple?.effects.submits).toBe(0);

    // The human reads Resolution Center and says so.
    const pending = await harness.call('agentship_pending', { action: 'list' });
    const resolution = (pending.payload['pending'] as { id: string }[]).find((entry) =>
      entry.id.includes('resolution-center'),
    );
    expect(resolution).toBeDefined();
    await harness.call('agentship_pending', {
      action: 'complete',
      id: resolution?.id as string,
      notes: 'Reviewer asked for a clearer purpose string; fixed.',
    });

    await driveToConvergence(harness);
    expect(apple?.effects.submits).toBe(1);
    expect(apple?.state.versions.find((v) => v.version === '1.1.0')?.state).toBe('waiting_review');
  });
});

describe('Apple: interruptions', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('never uploads twice when the connection dies after the upload landed', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: appleManifest() });
    const apple = harness.adapters.get('apple');
    apple?.injectFailure({ operation: 'uploadBuild', phase: 'after' });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const failed = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(failed.payload['ok']).toBe(false);
    expect(apple?.effects.uploads).toBe(1);

    const resumed = await harness.call('agentship_resume', {});
    const remaining = resumed.payload['plan'] as { actions: { kind: string }[] };
    expect(remaining.actions.some((action) => action.kind === 'upload_build')).toBe(false);

    await driveToConvergence(harness);
    expect(apple?.effects.uploads).toBe(1);
    expect(apple?.effects.submits).toBe(1);
  });

  it('waits out build processing instead of submitting an unprocessed binary', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: appleManifest(),
      processingTicks: 2,
    });
    const apple = harness.adapters.get('apple');
    await harness.call('agentship_plan', { projectDir: harness.repoRoot });

    await driveToConvergence(harness, 8);
    expect(apple?.effects.uploads).toBe(1);
    expect(apple?.effects.submits).toBe(1);
    expect(apple?.state.builds[0]?.state).toBe('valid');
  });

  it('resumes cleanly when the store rejects an op mid-run', async () => {
    harness = await createMcpHarness({ stores: ['apple'], manifest: appleManifest() });
    const apple = harness.adapters.get('apple');
    apple?.injectFailure({ operation: 'setMetadata', phase: 'before' });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const failed = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(failed.payload['ok']).toBe(false);
    expect(apple?.effects.metadataWrites).toBe(0);

    await driveToConvergence(harness);
    expect(apple?.effects.metadataWrites).toBe(1);
    expect(apple?.effects.submits).toBe(1);
  });
});

describe('Apple: an update to a live app', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('rolls out with a phased release once Apple is holding the approved version', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: appleManifest({
        release: {
          version: '1.1.0',
          buildNumber: '42',
          track: 'production',
          strategy: 'manual',
          phased: true,
          artifacts: { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } },
        },
      }),
      state: () => ({
        versions: [
          { id: 'v-1', version: '1.0.0', state: 'live', track: 'production' },
          { id: 'v-2', version: '1.1.0', state: 'pending_release', track: 'production' },
        ],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
      }),
    });
    const apple = harness.adapters.get('apple');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const kinds = actionsOf(planned.payload).map((action) => action.kind);
    // The version is frozen, so nothing edits it; what is left is the rollout and the
    // console-only release button.
    expect(kinds).toContain('set_phased_release');
    expect(kinds).toContain('release_version');
    expect(kinds).not.toContain('submit_for_review');

    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(apple?.effects.phasedWrites).toBe(1);
    // Releasing has no API through the pinned tool, so it comes back as console work.
    const emitted = applied.payload['emittedPending'] as { id: string }[];
    const pending = await harness.call('agentship_pending', { action: 'list' });
    const ids = (pending.payload['pending'] as { id: string }[]).map((entry) => entry.id);
    expect([...ids, ...emitted.map((entry) => entry.id)]).toContain('apple:release-version');
  });

  it('changes an approved version’s metadata only through a new version', async () => {
    harness = await createMcpHarness({
      stores: ['apple'],
      manifest: appleManifest(),
      state: () => ({
        versions: [{ id: 'v-2', version: '1.1.0', state: 'in_review', track: 'production' }],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
      }),
    });
    const apple = harness.adapters.get('apple');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const actions = actionsOf(planned.payload);
    expect(actions.some((action) => action.kind === 'set_metadata')).toBe(false);
    expect(actions.some((action) => action.kind === 'submit_for_review')).toBe(false);
    const version = actions.find((action) => action.kind === 'ensure_version');
    expect(version?.classification).toBe('needs_input');

    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(apple?.effects.metadataWrites).toBe(0);
    expect(apple?.effects.submits).toBe(0);
  });
});

describe('Apple: the manifest still has gaps', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('asks for the missing value instead of inventing one', async () => {
    const repo = await createMcpHarness({ stores: ['apple'], manifest: appleManifest() });
    harness = repo;
    await saveManifest(
      repo.repoRoot,
      appleManifest({
        metadata: {
          primaryLocale: 'en-US',
          locales: { 'en-US': { name: 'Mock App', description: '<needs_input>' } },
        },
      }),
    );
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const metadata = actionsOf(planned.payload).find((action) => action.kind === 'set_metadata');
    expect(metadata?.classification).toBe('needs_input');
  });
});
