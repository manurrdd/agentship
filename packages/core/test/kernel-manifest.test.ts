import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentshipError,
  type AppAnalysis,
  loadManifest,
  manifestFromAnalysis,
  manifestGaps,
  manifestPath,
  NEEDS_INPUT,
  provenanced,
  saveManifest,
  writeGeneratedManifest,
} from '@agentship/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testManifest } from './kernel-helpers.js';

function analysisFixture(): AppAnalysis {
  return {
    schemaVersion: 1,
    analyzedAt: '2026-08-03T00:00:00.000Z',
    root: '/repo',
    framework: { framework: 'flutter', confidence: 'certain', evidence: [] },
    platforms: ['ios', 'android'],
    identity: {
      bundleId: provenanced('com.example.app', 'certain', 'ios/Runner/Info.plist'),
      packageName: provenanced('com.example.app', 'inferred', 'android/app/build.gradle'),
      displayName: provenanced('Example', 'guess', undefined, 'from directory name'),
    },
    versions: {
      marketingVersion: provenanced('1.4.0', 'certain', 'pubspec.yaml'),
    },
    sdks: [],
    permissions: { ios: [], android: [] },
    entitlements: [],
    privacySignals: [],
    assets: { appIcons: [], screenshots: [], listingFiles: [] },
    buildHints: { appDir: '.' },
    warnings: [],
    stats: { filesScanned: 1, directoriesScanned: 1, truncated: false, durationMs: 1 },
  };
}

describe('manifest', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agentship-manifest-'));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('round-trips through save and load', async () => {
    const manifest = testManifest({ stores: ['apple', 'google'] });
    await saveManifest(repoRoot, manifest);
    const loaded = await loadManifest(repoRoot);
    expect(loaded).toEqual(manifest);
  });

  it('fails loading with CONFIG_NOT_FOUND when no manifest exists', async () => {
    await expect(loadManifest(repoRoot)).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });

  it('rejects an unsupported manifest version', async () => {
    const manifest = testManifest();
    await saveManifest(repoRoot, manifest);
    const path = manifestPath(repoRoot);
    const raw = (await readFile(path, 'utf8')).replace('version: 1', 'version: 99');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, raw);
    await expect(loadManifest(repoRoot)).rejects.toMatchObject({
      code: 'CONFIG_UNSUPPORTED_VERSION',
    });
  });

  it('rejects a manifest that fails validation', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(repoRoot, '.agentship'), { recursive: true });
    await writeFile(manifestPath(repoRoot), 'version: 1\napp:\n  name: X\n');
    await expect(loadManifest(repoRoot)).rejects.toSatisfy(
      (error: unknown) => AgentshipError.is(error) && error.code === 'CONFIG_MANIFEST_INVALID',
    );
  });

  it('generates a manifest with needs_input sentinels and inferred comments', async () => {
    const generated = manifestFromAnalysis(analysisFixture());

    // The description is unknowable from the repo: explicit needs_input.
    expect(generated.manifest.metadata.locales['en-US']?.description).toBe(NEEDS_INPUT);
    expect(generated.gaps.map((gap) => gap.path)).toContain('metadata.locales.en-US.description');
    // Certain values carry no marker; inferred/guessed ones are annotated in the YAML.
    expect(generated.yaml).toContain('bundleId: com.example.app\n');
    expect(generated.yaml).toMatch(/packageName: com\.example\.app #.*inferred/);
    expect(generated.yaml).toMatch(/name: Example #.*inferred \(guess\)/);
    expect(generated.yaml).toMatch(/description: <needs_input> #.*needs_input/);

    // And what it writes always loads.
    const written = await writeGeneratedManifest(repoRoot, analysisFixture());
    const loaded = await loadManifest(repoRoot);
    expect(loaded).toEqual(written.manifest);
  });

  it('reports every sentinel through manifestGaps', () => {
    const manifest = testManifest();
    const withGap = {
      ...manifest,
      release: { ...manifest.release, version: NEEDS_INPUT },
    };
    expect(manifestGaps(withGap).map((gap) => gap.path)).toEqual(['release.version']);
  });
});
