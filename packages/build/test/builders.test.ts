import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentshipManifest, ERROR_CODES, ManifestSchema } from '@agentship/core';
import plist from 'plist';
import { afterEach, describe, expect, it } from 'vitest';
import { gradleTask, outputCandidates, outputDirFor } from '../src/android.js';
import { BUILD_DIAGNOSTICS, diagnose, meaningfulTail } from '../src/diagnostics.js';
import { exportOptions, resolveProjectTarget } from '../src/ios.js';
import { builderFor, buildSupport, detectProject } from '../src/matrix.js';

/**
 * The decisions a build makes before it runs anything: which project this is, which builder
 * can produce each artifact, what the command line looks like, and what a failure means.
 *
 * All of it is pure enough to test offline, which matters: the real builds are gated behind
 * `AGENTSHIP_E2E_BUILD=1` because they need Xcode, a JDK and ten minutes, and everything that
 * can be decided without them should fail fast and locally.
 */
function manifest(overrides: Record<string, unknown> = {}): AgentshipManifest {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Example' },
    stores: { apple: { bundleId: 'com.example.app', appId: 'app-1' } },
    release: { version: '1.0.0', buildNumber: '7', track: 'internal_testing' },
    metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Example' } } },
    ...overrides,
  });
}

interface Repo {
  readonly root: string;
  cleanup(): Promise<void>;
}

async function repoWith(files: readonly string[]): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'agentship-project-'));
  for (const file of files) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '');
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('recognising a project', () => {
  let repo: Repo | undefined;
  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('reads a Flutter repository from its pubspec', async () => {
    repo = await repoWith(['pubspec.yaml', 'ios/Runner.xcodeproj/x', 'android/gradlew']);
    const shape = await detectProject(repo.root, manifest());
    expect(shape.framework).toBe('flutter');
    expect(builderFor(shape, 'ios')).toBe('flutter-ios');
    expect(builderFor(shape, 'android')).toBe('flutter-android');
  });

  it('reads a React Native repository from its node_modules', async () => {
    repo = await repoWith([
      'package.json',
      'node_modules/react-native/package.json',
      'ios/App.xcworkspace/x',
      'android/gradlew',
    ]);
    const shape = await detectProject(repo.root, manifest());
    expect(shape.framework).toBe('react-native');
    expect(builderFor(shape, 'ios')).toBe('ios-xcodebuild');
    expect(builderFor(shape, 'android')).toBe('android-gradle');
  });

  it('refuses to build an Expo managed project and says why', async () => {
    repo = await repoWith(['package.json', 'app.json']);
    const shape = await detectProject(repo.root, manifest());
    expect(shape.expoManaged).toBe(true);
    const support = await buildSupport(manifest(), shape, 'ios');
    expect(support.status).toBe('unsupported');
    // The one thing Agentship must never do on its own.
    expect(support.remediation).toContain('expo prebuild');
    expect(support.remediation).toContain('overwrite native changes');
  });

  it('reports a missing Gradle wrapper rather than falling back to a global gradle', async () => {
    repo = await repoWith(['package.json', 'node_modules/react-native/package.json', 'android/x']);
    const shape = await detectProject(repo.root, manifest());
    const support = await buildSupport(
      manifest({ stores: { google: { packageName: 'com.example.app' } } }),
      shape,
      'android',
    );
    expect(support.status).toBe('tool_missing');
    expect(support.detail).toContain('Gradle wrapper');
  });

  it('asks for the scheme instead of guessing one', async () => {
    repo = await repoWith(['ios/App.xcworkspace/x', 'Podfile']);
    const shape = await detectProject(repo.root, manifest());
    const support = await buildSupport(manifest(), shape, 'ios');
    if (process.platform === 'darwin') {
      expect(support.status).toBe('needs_input');
      expect(support.needsInput).toContain('build.ios.scheme');
    } else {
      // Off macOS the platform check wins, which is the more important honesty.
      expect(support.status).toBe('host_unsupported');
    }
  });
});

describe('the Xcode command line', () => {
  let repo: Repo | undefined;
  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it('exports for the App Store without uploading', () => {
    const parsed = plist.parse(exportOptions({ teamId: 'ABCDE12345' })) as Record<string, unknown>;
    expect(parsed['method']).toBe('app-store-connect');
    // Agentship uploads through the adapter, where the upload is journaled and resumable.
    expect(parsed['destination']).toBe('export');
    expect(parsed['signingStyle']).toBe('automatic');
    expect(parsed['teamID']).toBe('ABCDE12345');
  });

  it('prefers a workspace over a project, because CocoaPods needs one', async () => {
    repo = await repoWith(['App.xcworkspace/contents', 'App.xcodeproj/project.pbxproj']);
    const target = await resolveProjectTarget(repo.root, manifest());
    expect(target.flag).toBe('-workspace');
  });

  it('refuses to choose between two containers', async () => {
    repo = await repoWith(['One.xcodeproj/p', 'Two.xcodeproj/p']);
    await expect(resolveProjectTarget(repo.root, manifest())).rejects.toMatchObject({
      code: ERROR_CODES.BUILD_INPUT_REQUIRED,
    });
  });
});

describe('the Gradle command line', () => {
  it('names the task for a module, flavour and build type', () => {
    expect(gradleTask({ module: 'app', buildType: 'release', artifact: 'aab' })).toBe(
      ':app:bundleRelease',
    );
    expect(
      gradleTask({ module: 'app', flavor: 'prod', buildType: 'release', artifact: 'aab' }),
    ).toBe(':app:bundleProdRelease');
    expect(gradleTask({ module: 'mobile', buildType: 'release', artifact: 'apk' })).toBe(
      ':mobile:assembleRelease',
    );
  });

  it('knows where AGP writes each variant', () => {
    expect(
      outputDirFor({
        gradleDir: '/repo/android',
        module: 'app',
        flavor: 'prod',
        buildType: 'release',
        artifact: 'aab',
      }),
    ).toBe('/repo/android/app/build/outputs/bundle/prodRelease');
  });

  it('also looks where a relocated buildDir would put it', () => {
    // Flutter's template moves buildDir to a shared build/ at the repository root, so
    // guessing one path and failing would break every Flutter project.
    const candidates = outputCandidates({
      gradleDir: '/repo/android',
      repoRoot: '/repo',
      appDir: '/repo',
      module: 'app',
      buildType: 'release',
      artifact: 'aab',
    });
    expect(candidates[0]).toBe('/repo/android/app/build/outputs/bundle/release');
    expect(candidates).toContain('/repo/build/app/outputs/bundle/release');
  });
});

describe('diagnosing a failed build', () => {
  it('turns unaccepted agreements into console work, not a retry', () => {
    const diagnosis = diagnose(
      'error: You must accept the updated Program License Agreement in App Store Connect.',
    );
    expect(diagnosis.rule?.id).toBe('apple.agreements');
    expect(diagnosis.code).toBe(ERROR_CODES.BUILD_SIGNING_FAILED);
    expect(diagnosis.pending?.actionClass).toBe('human_only');
  });

  it('separates a missing certificate from a missing profile', () => {
    expect(diagnose('No signing certificate "iOS Distribution" found').rule?.id).toBe(
      'apple.no-signing-certificate',
    );
    expect(diagnose("No profiles for 'com.example.app' were found").rule?.id).toBe(
      'apple.no-profile',
    );
  });

  it('recognises the two ways a JDK ruins a Gradle build', () => {
    expect(diagnose('Unsupported class file major version 65').rule?.id).toBe(
      'android.jdk-incompatible',
    );
    expect(diagnose('SDK location not found. Define a valid SDK location').rule?.id).toBe(
      'android.sdk-missing',
    );
  });

  it('maps a wrong keystore password to a fix that is not "try again"', () => {
    const diagnosis = diagnose('Keystore was tampered with, or password was incorrect');
    expect(diagnosis.rule?.id).toBe('android.keystore-password');
    expect(diagnosis.remediation?.summary).toContain('agentship_configure_auth');
  });

  it('falls back to the last meaningful lines rather than to a guess', () => {
    const diagnosis = diagnose(
      ['note: something', 'warning: whatever', '', 'FAILURE: totally novel error'].join('\n'),
    );
    expect(diagnosis.rule).toBeUndefined();
    expect(diagnosis.code).toBe(ERROR_CODES.BUILD_FAILED);
    expect(diagnosis.evidence).toContain('FAILURE: totally novel error');
    expect(diagnosis.remediation?.summary).toContain('will not guess');
  });

  it('drops the noise every build tool prints', () => {
    const tail = meaningfulTail(
      ['> Task :app:compileRelease', 'Download https://example', 'real cause here'].join('\n'),
    );
    expect(tail).toEqual(['real cause here']);
  });

  it('has a stable id for every rule, so a report can cite one', () => {
    const ids = BUILD_DIAGNOSTICS.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
