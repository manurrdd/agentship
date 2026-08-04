import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ManifestSchema } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { actionsOf, createMcpHarness, type McpHarness, outcomesOf } from './helpers.js';

/**
 * A whole Google Play release, driven through MCP against the mock store.
 *
 * The two properties these scenarios exist to prove are Play-specific and easy to get
 * wrong: a typical apply must commit **one** edit (every extra commit is another chance to
 * cancel a running review), and a staged rollout must never advance on its own.
 */
function googleManifest(overrides: Record<string, unknown> = {}) {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: { google: { packageName: 'com.example.mock' } },
    release: {
      version: '1.1.0',
      buildNumber: '42',
      track: 'internal_testing',
      artifacts: { google: { path: 'artifacts/app.aab', kind: 'aab' } },
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: {
        'en-US': {
          name: 'Mock App',
          shortDescription: 'A calmer app.',
          description: 'Fresh new description.',
        },
      },
    },
    ...overrides,
  });
}

async function withScreenshots(harness: McpHarness): Promise<void> {
  const dir = join(harness.repoRoot, 'screenshots');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'one.png'), 'first screenshot bytes');
  await writeFile(join(dir, 'two.png'), 'second screenshot bytes');
}

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
    if (!outcomesOf(applied.payload).some((outcome) => outcome.status === 'done')) return;
  }
}

describe('Google: a release to a testing track', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('commits listing, images, bundle and release as exactly one edit', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: googleManifest({
        assets: {
          screenshots: [
            {
              locale: 'en-US',
              device: 'phone',
              files: ['screenshots/one.png', 'screenshots/two.png'],
            },
          ],
        },
      }),
    });
    await withScreenshots(harness);
    const google = harness.adapters.get('google');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const kinds = actionsOf(planned.payload).map((action) => action.kind);
    expect(kinds).toEqual([
      'set_metadata',
      'sync_screenshots',
      'upload_build',
      'submit_for_review',
    ]);

    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(applied.payload['ok']).toBe(true);
    // The whole release is one Play edit: one commit, one chance of collision, one thing
    // to recover from.
    expect(google?.effects.edits).toBe(1);
    expect(google?.effects.uploads).toBe(1);
    expect(google?.effects.imageWrites).toBe(1);

    const after = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    expect(actionsOf(after.payload)).toHaveLength(0);
  });

  it('reports every op of a committed edit as atomic', async () => {
    harness = await createMcpHarness({ stores: ['google'], manifest: googleManifest() });
    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    const outcomes = applied.payload['outcomes'] as { status: string; atomic?: boolean }[];
    for (const outcome of outcomes.filter((entry) => entry.status === 'done')) {
      expect(outcome.atomic).toBe(true);
    }
  });

  it('re-syncs nothing when the screenshots already match by hash', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: googleManifest({
        assets: {
          screenshots: [{ locale: 'en-US', device: 'phone', files: ['screenshots/one.png'] }],
        },
      }),
    });
    await withScreenshots(harness);
    const google = harness.adapters.get('google');

    await driveToConvergence(harness);
    expect(google?.effects.imageWrites).toBe(1);
    await driveToConvergence(harness);
    // Idempotence by SHA-256: a second run recognises the published images.
    expect(google?.effects.imageWrites).toBe(1);
  });
});

describe('Google: a review is already running', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('refuses to commit rather than cancelling the running review', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: googleManifest({
        release: {
          version: '1.1.0',
          buildNumber: '42',
          track: 'production',
          artifacts: { google: { path: 'artifacts/app.aab', kind: 'aab' } },
        },
      }),
      state: () => ({ reviewInProgress: true }),
    });
    const google = harness.adapters.get('google');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });

    expect(applied.payload['ok']).toBe(false);
    const failure = outcomesOf(applied.payload).find((outcome) => outcome.status === 'failed');
    expect(failure).toBeDefined();
    const detail = (applied.payload['outcomes'] as { errorCode?: string; errorMessage?: string }[])
      .map((outcome) => `${outcome.errorCode ?? ''} ${outcome.errorMessage ?? ''}`)
      .join(' ');
    expect(detail).toContain('already in review');
    // The edit was discarded whole: nothing landed, so a resume replans from a clean store.
    expect(google?.effects.edits).toBe(0);
    expect(google?.effects.uploads).toBe(0);
    expect(google?.effects.metadataWrites).toBe(0);
  });

  it('stages the change instead, once managed publishing is declared', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: googleManifest({
        release: {
          version: '1.1.0',
          buildNumber: '42',
          track: 'production',
          managedPublishing: true,
          artifacts: { google: { path: 'artifacts/app.aab', kind: 'aab' } },
        },
      }),
      state: () => ({ reviewInProgress: true, managedPublishing: true }),
    });
    const google = harness.adapters.get('google');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const applied = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(applied.payload['ok']).toBe(true);
    expect(google?.effects.edits).toBe(1);

    // Committed but not published: the console step is what finishes it.
    const pending = await harness.call('agentship_pending', { action: 'list' });
    const ids = (pending.payload['pending'] as { id: string }[]).map((entry) => entry.id);
    expect(ids).toContain('google:managed-publishing');
  });
});

describe('Google: promotion and staged rollout', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  const promoteManifest = (rollout: number) =>
    googleManifest({
      release: {
        version: '1.1.0',
        buildNumber: '42',
        track: 'production',
        promoteFrom: 'open_testing',
        rollout,
        artifacts: { google: { path: 'artifacts/app.aab', kind: 'aab' } },
      },
    });

  it('promotes at 10%, then raises to 100% only when asked', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: promoteManifest(0.1),
      state: () => ({
        tracks: [{ track: 'open_testing', buildNumbers: ['42'], state: 'live' }],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
        localizations: new Map([
          [
            'en-US',
            {
              name: 'Mock App',
              shortDescription: 'A calmer app.',
              description: 'Fresh new description.',
            },
          ],
        ]),
      }),
    });
    const google = harness.adapters.get('google');

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const promote = actionsOf(planned.payload).find((action) => action.kind === 'promote_release');
    expect(promote?.classification).toBe('needs_approval');
    // Promotion serves the artifact that is already there.
    expect(actionsOf(planned.payload).some((action) => action.kind === 'upload_build')).toBe(false);

    await driveToConvergence(harness);
    const production = google?.state.tracks.find((track) => track.track === 'production');
    expect(production?.buildNumbers).toEqual(['42']);

    // Nothing raised the fraction by itself while converging.
    expect(google?.effects.phasedWrites).toBeLessThanOrEqual(1);

    // Now the manifest asks for everyone, and only then does the rollout move.
    const before = google?.effects.phasedWrites ?? 0;
    const { saveManifest } = await import('@agentship/core');
    await saveManifest(harness.repoRoot, promoteManifest(1));
    await driveToConvergence(harness);
    expect(google?.effects.phasedWrites ?? 0).toBeGreaterThan(before);
    expect(google?.state.phasedRelease?.userFraction).toBe(1);
  });

  it('does not touch a rollout the manifest says nothing about', async () => {
    harness = await createMcpHarness({
      stores: ['google'],
      manifest: googleManifest({
        release: {
          version: '1.1.0',
          buildNumber: '42',
          track: 'production',
          artifacts: { google: { path: 'artifacts/app.aab', kind: 'aab' } },
        },
      }),
      state: () => ({
        tracks: [{ track: 'production', buildNumbers: ['42'], state: 'live', userFraction: 0.2 }],
        builds: [{ id: 'b-1', buildNumber: '42', state: 'valid', ticksLeft: 0 }],
      }),
    });
    const google = harness.adapters.get('google');
    await driveToConvergence(harness);
    // A rollout in progress is someone's deliberate decision; Agentship leaves it alone.
    expect(google?.effects.phasedWrites).toBe(0);
    expect(google?.state.tracks.find((track) => track.track === 'production')?.userFraction).toBe(
      0.2,
    );
  });
});

describe('Google: interruptions', () => {
  let harness: McpHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('leaves nothing half-applied when the commit fails', async () => {
    harness = await createMcpHarness({ stores: ['google'], manifest: googleManifest() });
    const google = harness.adapters.get('google');
    google?.injectFailure({ operation: 'commit', phase: 'before' });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    const failed = await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(failed.payload['ok']).toBe(false);
    expect(google?.effects.edits).toBe(0);
    expect(google?.effects.uploads).toBe(0);

    await driveToConvergence(harness);
    expect(google?.effects.edits).toBe(1);
    expect(google?.effects.uploads).toBe(1);
  });

  it('does not re-upload a version code the store already has', async () => {
    harness = await createMcpHarness({ stores: ['google'], manifest: googleManifest() });
    const google = harness.adapters.get('google');
    // The edit commits and *then* the connection dies: the write-ahead case.
    google?.injectFailure({ operation: 'commit', phase: 'after' });

    const planned = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
    const plan = planned.payload['plan'] as { planId: string; approvalsRequired: string[] };
    await harness.call('agentship_apply', {
      planId: plan.planId,
      approvals: plan.approvalsRequired,
    });
    expect(google?.effects.uploads).toBe(1);

    const resumed = await harness.call('agentship_resume', {});
    const remaining = resumed.payload['plan'] as { actions: { kind: string }[] };
    expect(remaining.actions.some((action) => action.kind === 'upload_build')).toBe(false);
    expect(google?.effects.uploads).toBe(1);
  });
});
