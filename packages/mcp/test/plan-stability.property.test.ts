import { ManifestSchema, saveManifest } from '@agentship/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { actionsOf, createMcpHarness } from './helpers.js';

/**
 * Action ids must depend on what an action *does*, never on how the manifest was written.
 *
 * This matters because an id is an approval. If reordering the locales in a YAML file — or
 * adding a locale that changes nothing — rotated the ids, every approval a user had given
 * would silently become stale, and the agent would ask again for changes it already asked
 * about. Worse, a user could approve one plan and get a different one.
 *
 * The property: for any permutation of the manifest's locales and screenshot sets, the plan
 * is identical, id for id.
 */
function manifestWith(locales: readonly string[], screenshots: readonly string[]) {
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
      locales: Object.fromEntries(
        locales.map((locale) => [
          locale,
          { name: `Mock App ${locale}`, description: `Description for ${locale}.` },
        ]),
      ),
    },
    assets: {
      screenshots: screenshots.map((locale) => ({
        locale,
        device: 'phone' as const,
        files: ['artifacts/app.aab'],
      })),
    },
  });
}

const LOCALES = ['en-US', 'es-ES', 'fr-FR', 'de-DE'];

describe('plan stability (property)', () => {
  it('produces the same ids whatever order the manifest lists things in', async () => {
    // One harness, re-saving the manifest between rounds: the store must be identical too,
    // or the comparison would be measuring drift instead of ordering.
    const harness = await createMcpHarness({
      stores: ['google'],
      manifest: manifestWith(LOCALES, LOCALES),
    });
    try {
      const baseline = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
      const baselineIds = actionsOf(baseline.payload).map((action) => action.id);
      const baselinePlanId = (baseline.payload['plan'] as { planId: string }).planId;
      expect(baselineIds.length).toBeGreaterThan(0);

      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(LOCALES, { minLength: LOCALES.length }),
          fc.shuffledSubarray(LOCALES, { minLength: LOCALES.length }),
          async (locales, screenshots) => {
            await saveManifest(harness.repoRoot, manifestWith(locales, screenshots));
            const planned = await harness.call('agentship_plan', {});
            expect(actionsOf(planned.payload).map((action) => action.id)).toEqual(baselineIds);
            expect((planned.payload['plan'] as { planId: string }).planId).toBe(baselinePlanId);
          },
        ),
        { numRuns: 40 },
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it('rotates the ids when the content actually changes', async () => {
    const harness = await createMcpHarness({
      stores: ['google'],
      manifest: manifestWith(['en-US'], []),
    });
    try {
      const before = await harness.call('agentship_plan', { projectDir: harness.repoRoot });
      const beforeIds = actionsOf(before.payload).map((action) => action.id);

      await saveManifest(
        harness.repoRoot,
        ManifestSchema.parse({
          ...manifestWith(['en-US'], []),
          metadata: {
            primaryLocale: 'en-US',
            locales: { 'en-US': { name: 'Mock App en-US', description: 'Something else.' } },
          },
        }),
      );
      const after = await harness.call('agentship_plan', {});
      const afterIds = actionsOf(after.payload).map((action) => action.id);

      // The whole point of hashing content: a real change invalidates the approval.
      expect(afterIds).not.toEqual(beforeIds);
      expect(afterIds.some((id) => id.startsWith('set_metadata:'))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});
