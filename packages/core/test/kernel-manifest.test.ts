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
  scrubStrings,
  writeGeneratedManifest,
} from '@agentship/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testManifest } from './kernel-helpers.js';

function analysisFixture(): AppAnalysis {
  return {
    schemaVersion: 2,
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
    launchChecks: [],
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

  /**
   * A validation failure has to survive the trip to an agent intact.
   *
   * It used to be reported as Zod's tree, which mirrors the manifest's own nesting — and
   * every channel that carries an error to a model has a depth limit, so a field five
   * levels down arrived as `{"purposes": {"errors": "[truncated]"}}`. The agent knew the
   * file was invalid and could not find out why, so it guessed at the user's configuration.
   * The paths below are the ones that actually failed in real sessions.
   */
  it('names every invalid field by path, at a depth that survives redaction', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(repoRoot, '.agentship'), { recursive: true });
    await writeFile(
      manifestPath(repoRoot),
      [
        'version: 1',
        'app: {name: X}',
        'stores: {apple: {bundleId: com.x.y, appId: "123"}}',
        'metadata: {primaryLocale: en-US, locales: {en-US: {name: X, description: d}}}',
        'release: {version: "1.0.0", buildNumber: 2, track: internal_testing, strategy: manual}',
        'privacy:',
        '  declarationStatus: pendiente',
        '  dataPractices: [{dataType: email, purposes: [selling_hats]}]',
        '',
      ].join('\n'),
    );

    const error = await loadManifest(repoRoot).catch((cause: unknown) => cause);
    expect(AgentshipError.is(error)).toBe(true);
    const issues = (error as AgentshipError).details?.['issues'] as { path: string }[];
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('release.buildNumber');
    expect(paths).toContain('privacy.declarationStatus');
    // Array members are addressed by index, so the user can find the offending entry.
    expect(paths).toContain('privacy.dataPractices[0].dataType');
    expect(paths).toContain('privacy.dataPractices[0].purposes[0]');

    // The whole payload is two levels deep whatever the manifest looks like, so nothing is
    // cut on the way out — the check that the old tree shape failed.
    const survived = scrubStrings({ details: { issues } }) as {
      details: { issues: { path: string; message: string }[] };
    };
    expect(survived.details.issues).toEqual(issues);
    expect(JSON.stringify(survived)).not.toContain('[truncated]');

    // And the message alone is enough to act on, without opening `details`.
    expect((error as AgentshipError).message).toContain('privacy.declarationStatus');
    // It must not tell the agent to go and edit the user's file.
    expect((error as AgentshipError).remediation?.summary).toMatch(/user/i);
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

  it('carries the build number the project already declares', () => {
    // Flutter writes `1.4.0+2` in pubspec.yaml, so the analyzer knows the build number and
    // there is nothing to ask the user for. Without this the first build stops with
    // "the manifest does not say release.buildNumber" for a value the repo states.
    const analysis = analysisFixture();
    const generated = manifestFromAnalysis({
      ...analysis,
      versions: {
        ...analysis.versions,
        buildNumber: provenanced('2', 'certain', 'pubspec.yaml'),
      },
    });
    expect(generated.manifest.release.buildNumber).toBe('2');
    expect(generated.gaps.map((gap) => gap.path)).not.toContain('release.buildNumber');
  });

  it('falls back to the Android version code, and omits what the project never states', () => {
    const analysis = analysisFixture();
    expect(
      manifestFromAnalysis({
        ...analysis,
        versions: { ...analysis.versions, versionCode: provenanced(7, 'certain', 'build.gradle') },
      }).manifest.release.buildNumber,
    ).toBe('7');
    // Absent from the project stays absent: an invented build number is uploaded under that
    // name and burned forever.
    expect(manifestFromAnalysis(analysis).manifest.release.buildNumber).toBeUndefined();
  });

  it('reveals the optional sections instead of leaving them undiscoverable', () => {
    const analysis = analysisFixture();
    const generated = manifestFromAnalysis({
      ...analysis,
      assets: {
        ...analysis.assets,
        listingFiles: [
          'fastlane/metadata/en-US/description.txt',
          'fastlane/metadata/es-ES/description.txt',
          'fastlane/metadata/android/fr-FR/full_description.txt',
        ],
      },
    });

    // Commented, never filled in: each of these is a decision about money, a person or a
    // product catalog.
    expect(generated.yaml).toContain('# pricing:');
    expect(generated.yaml).toContain('# review:');
    expect(generated.yaml).toContain('# monetization:');
    expect(generated.yaml).toContain('contactPhone');
    // The locales the repository already has listing text for are named, not adopted.
    expect(generated.yaml).toContain('listing text for: es-ES, fr-FR');
    expect(Object.keys(generated.manifest.metadata.locales)).toEqual(['en-US']);
    expect(generated.manifest.pricing).toBeUndefined();
    expect(generated.manifest.review).toBeUndefined();
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
