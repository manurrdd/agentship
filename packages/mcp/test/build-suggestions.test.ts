import { writeFile } from 'node:fs/promises';
import { ManifestSchema } from '@agentship/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpHarness, type McpHarness } from './helpers.js';

describe('project-derived build input suggestions', () => {
  let harness: McpHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('surfaces an analyzed build number that the manifest omitted, without writing it', async () => {
    const manifest = ManifestSchema.parse({
      version: 1,
      app: { name: 'Example' },
      stores: { apple: { bundleId: 'com.example.app', appId: 'app-1' } },
      release: { version: '1.0.0', track: 'internal_testing' },
      metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Example' } } },
    });
    harness = await createMcpHarness({ stores: ['apple'], manifest });
    await writeFile(
      `${harness.repoRoot}/pubspec.yaml`,
      'name: example\nversion: 1.0.0+9\ndependencies:\n  flutter:\n    sdk: flutter\n',
    );

    expect(
      (await harness.call('agentship_analyze', { projectDir: harness.repoRoot })).isError,
    ).toBe(false);
    const status = await harness.call('agentship_build', {
      projectDir: harness.repoRoot,
      action: 'status',
    });
    const support = status.payload['support'] as {
      suggestedInputs?: { path: string; value: string; source: string }[];
    }[];
    expect(support[0]?.suggestedInputs).toContainEqual(
      expect.objectContaining({ path: 'release.buildNumber', value: '9', source: 'pubspec.yaml' }),
    );
    expect(status.payload['nextStep']).toContain('do not ask the user to rediscover');
  });
});
