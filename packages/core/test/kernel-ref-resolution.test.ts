import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentshipManifest,
  loadManifest,
  ManifestSchema,
  mergePendingOperations,
  type PendingOperation,
} from '@agentship/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './kernel-helpers.js';

/**
 * The kernel resolves what the store already knows instead of asking the user for it.
 *
 * `stores.apple.appId` only exists once the app record does, and App Store Connect can be
 * asked for it by bundle id. These tests pin the behaviour: a missing app id is looked up
 * once, persisted with a provenance comment, and reported; an id that is already present
 * costs no store call; a lookup that finds nothing keeps the original PLAN_INPUT_REQUIRED.
 * They also pin that verifying a pending operation touches only that operation's store.
 */
function manifestWithoutAppId(overrides: Record<string, unknown> = {}): AgentshipManifest {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Mock App' },
    stores: {
      apple: { bundleId: 'com.example.mock' },
      google: { packageName: 'com.example.mock' },
    },
    release: {
      version: '1.1.0',
      buildNumber: '42',
      track: 'internal_testing',
      artifacts: {
        apple: { path: 'artifacts/app.ipa', kind: 'ipa' },
        google: { path: 'artifacts/app.aab', kind: 'aab' },
      },
    },
    metadata: {
      primaryLocale: 'en-US',
      locales: { 'en-US': { name: 'Mock App', description: 'Fresh new description.' } },
    },
    ...overrides,
  });
}

describe('resolving stores.apple.appId from the bundle id', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('resolves, persists with a provenance comment, and reports it on the plan', async () => {
    harness = await createHarness({
      stores: ['apple'],
      manifest: manifestWithoutAppId({
        stores: { apple: { bundleId: 'com.example.mock' } },
        release: {
          version: '1.1.0',
          buildNumber: '42',
          track: 'internal_testing',
          artifacts: { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } },
        },
      }),
    });

    const plan = await harness.kernel.plan();
    expect(plan.warnings.join('\n')).toContain('Resolved stores.apple.appId to app-1');

    const manifest = await loadManifest(harness.repoRoot);
    expect(manifest.stores.apple?.appId).toBe('app-1');
    const yaml = await readFile(join(harness.repoRoot, '.agentship', 'agentship.yaml'), 'utf8');
    expect(yaml).toContain('appId: app-1 # resolved from App Store Connect by bundle id');
  });

  it('makes no store lookup when the app id is already in the manifest', async () => {
    harness = await createHarness({ stores: ['apple'] });
    const adapter = harness.adapters.get('apple');
    const spy = vi.spyOn(adapter as NonNullable<typeof adapter>, 'findApp');
    await harness.kernel.plan();
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps PLAN_INPUT_REQUIRED when the store has no app for the bundle id', async () => {
    harness = await createHarness({
      stores: ['apple'],
      manifest: manifestWithoutAppId({
        stores: { apple: { bundleId: 'com.nowhere.unknown' } },
        release: {
          version: '1.1.0',
          buildNumber: '42',
          track: 'internal_testing',
          artifacts: { apple: { path: 'artifacts/app.ipa', kind: 'ipa' } },
        },
      }),
    });
    await expect(harness.kernel.plan()).rejects.toMatchObject({ code: 'PLAN_INPUT_REQUIRED' });
    // Nothing was written: the manifest still has no app id.
    expect((await loadManifest(harness.repoRoot)).stores.apple?.appId).toBeUndefined();
  });
});

describe('verifying a pending operation of one store', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('does not require the other store to be identifiable', async () => {
    // Apple's bundle id resolves to nothing, so any code path that built Apple's ref
    // would throw — which is exactly what verifying a Google operation must not do.
    harness = await createHarness({
      stores: ['apple', 'google'],
      manifest: manifestWithoutAppId({
        stores: {
          apple: { bundleId: 'com.nowhere.unknown' },
          google: { packageName: 'com.example.mock' },
        },
      }),
    });

    const operation: PendingOperation = {
      id: 'google:content-rating',
      store: 'google',
      category: 'content_rating',
      title: 'Complete the questionnaire',
      reason: 'No API.',
      actionClass: 'agent_browser',
      status: 'done',
      verification: { summary: 'The questionnaire is done.', check: 'mock:content-rating-done' },
    };
    await mergePendingOperations(harness.repoRoot, [operation]);

    const [result] = await harness.kernel.verifyPending(['google:content-rating']);
    expect(result?.verified).toBe(true);
    expect(result?.operation.status).toBe('verified');
  });

  it('reads the store once for a whole batch, and not at all when nothing needs it', async () => {
    harness = await createHarness({ stores: ['google'] });
    const adapter = harness.adapters.get('google');
    const snapshots = vi.spyOn(adapter as NonNullable<typeof adapter>, 'getAppState');

    const done = (id: string, check?: string): PendingOperation => ({
      id,
      store: 'google',
      category: 'content_rating',
      title: id,
      reason: 'No API.',
      actionClass: 'agent_browser',
      status: 'done',
      verification: { summary: 'Done.', ...(check === undefined ? {} : { check }) },
    });
    await mergePendingOperations(harness.repoRoot, [
      done('google:content-rating', 'mock:content-rating-done'),
      done('google:app-content', 'mock:content-rating-done'),
      // Manual verification: a checklist a human reads, with no check to run.
      done('google:play-app-signing'),
    ]);

    const results = await harness.kernel.verifyPending([
      'google:content-rating',
      'google:app-content',
      'google:play-app-signing',
    ]);

    // Three operations, one store read: the snapshot is the expensive part, and issuing
    // these one call at a time is what made verification look like a hang.
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.verified)).toEqual([true, true, false]);
    expect(results[2]?.detail).toContain('no automatic verification');

    // Nothing to check means nothing to read.
    snapshots.mockClear();
    await harness.kernel.verifyPending(['google:play-app-signing']);
    expect(snapshots).not.toHaveBeenCalled();
  });
});
