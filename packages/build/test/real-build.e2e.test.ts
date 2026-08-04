import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, ManifestSchema, saveManifest } from '@agentship/core';
import { deleteKeystoreSecret, setKeystoreSecret } from '@agentship/credentials';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../src/build.js';
import { buildEnvironmentChecks } from '../src/environment.js';
import { findHostTool, runHostTool } from '../src/host.js';
import { detectKeystore, detectProject } from '../src/index.js';
import { listZipEntries } from '../src/zip.js';

/**
 * Real builds, against real toolchains, on a real machine.
 *
 * Gated behind `AGENTSHIP_E2E_BUILD=1` because they need Xcode or a JDK plus the Android SDK,
 * take minutes, and write into the user's `~/.agentship`. The fixtures are generated rather
 * than committed: an Xcode project or a Gradle wrapper checked into a repository rots with
 * every tooling release, and a generated one always matches the machine running it.
 *
 *     AGENTSHIP_E2E_BUILD=1 pnpm vitest run packages/build/test/real-build.e2e.test.ts
 *
 * The two Android cases are deliberately different. The first is the common case — a
 * project that signs itself, where Agentship injects nothing. The second is the one worth
 * proving: a project with no release signing at all, where Agentship supplies the key through
 * a Gradle init script and a 0600 properties file, without writing anything into the
 * repository.
 */
const enabled = process.env['AGENTSHIP_E2E_BUILD'] === '1';
const KEYSTORE_PASSWORD = 'agentship-e2e-fixture';
const E2E_PROFILE = 'agentship-e2e';

describe.skipIf(!enabled)('real builds', () => {
  it('reports what this machine can do', async () => {
    for (const check of await buildEnvironmentChecks()) {
      console.log(`${check.status.padEnd(12)} ${check.id}: ${check.detail}`);
    }
  });

  it(
    'builds a signed .aab from a project that signs itself',
    async () => {
      const flutter = await findHostTool('flutter');
      if (flutter === undefined) {
        console.log('skipping: no Flutter SDK on this machine');
        return;
      }
      const root = await createFlutterFixture(flutter);
      try {
        await writeKeystore(root, { intoProject: true });
        await saveManifest(root, androidManifest({ version: '1.2.3', buildNumber: '45' }));

        const outcome = await runBuild({ repoRoot: root, platform: 'android', profile: 'default' });
        console.log(`built ${outcome.artifact.path} in ${Math.round(outcome.durationMs / 1000)}s`);

        expect(outcome.artifact.kind).toBe('aab');
        expect(outcome.artifact.version).toBe('1.2.3');
        expect(outcome.artifact.sizeBytes).toBeGreaterThan(1_000_000);
        expect(outcome.warnings.join(' ')).toContain('signs its own release builds');
        await expectSignedWith(outcome.artifact.path, 'UPLOAD');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30 * 60_000,
  );

  it(
    'signs a project that has no signing configuration, without touching the repository',
    async () => {
      const flutter = await findHostTool('flutter');
      if (flutter === undefined) {
        console.log('skipping: no Flutter SDK on this machine');
        return;
      }
      const root = await createFlutterFixture(flutter);
      try {
        const keystore = await writeKeystore(root, { intoProject: false });
        await removeSigningConfig(root);
        await setKeystoreSecret(
          { storePassword: KEYSTORE_PASSWORD, keyPassword: KEYSTORE_PASSWORD },
          { profile: E2E_PROFILE },
        );
        await saveManifest(
          root,
          androidManifest({
            version: '2.0.0',
            buildNumber: '99',
            framework: 'android-native',
            keystore: { path: keystore, alias: 'upload', credentialProfile: E2E_PROFILE },
          }),
        );

        const manifest = await loadManifest(root);
        const shape = await detectProject(root, manifest);
        const state = await detectKeystore(shape.appDir, 'com.agentship.fixture', manifest);
        expect(state.origin).toBe('agentship');
        expect(state.secretStored).toBe(true);

        const gradleBefore = await readFile(join(root, 'android/app/build.gradle.kts'), 'utf8');
        const outcome = await runBuild({ repoRoot: root, platform: 'android', profile: 'default' });
        console.log(`built ${outcome.artifact.path} in ${Math.round(outcome.durationMs / 1000)}s`);

        expect(outcome.artifact.buildNumber).toBe('99');
        await expectSignedWith(outcome.artifact.path, 'UPLOAD');
        // The whole point of the init script: the project's own files are untouched, and no
        // key.properties was left behind.
        expect(await readFile(join(root, 'android/app/build.gradle.kts'), 'utf8')).toBe(
          gradleBefore,
        );
        await expect(readFile(join(root, 'android/key.properties'), 'utf8')).rejects.toThrow();
      } finally {
        await deleteKeystoreSecret({ profile: E2E_PROFILE }).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
    30 * 60_000,
  );

  it.skipIf(process.platform !== 'darwin')(
    'archives and exports a signed .ipa',
    async () => {
      const [xcodebuild, flutter] = await Promise.all([
        findHostTool('xcodebuild'),
        findHostTool('flutter'),
      ]);
      if (xcodebuild === undefined || flutter === undefined) {
        console.log('skipping: iOS builds need Xcode and the Flutter SDK on this machine');
        return;
      }
      // An iOS archive needs a real App Store Connect key: `-allowProvisioningUpdates` asks
      // Apple to issue the certificate and profile. Without credentials there is nothing to
      // test but the error path, and saying so beats pretending the case ran.
      const { credentialSource } = await import('@agentship/credentials');
      if ((await credentialSource('apple').catch(() => 'none')) === 'none') {
        console.log(
          'skipping: no App Store Connect credentials configured, so signing cannot be exercised',
        );
        return;
      }

      const root = await createFlutterFixture(flutter, ['ios']);
      try {
        await saveManifest(
          root,
          ManifestSchema.parse({
            version: 1,
            app: { name: 'Agentship Fixture' },
            stores: { apple: { bundleId: 'com.agentship.fixture', appId: 'unknown' } },
            release: { version: '1.2.3', buildNumber: '45' },
            build: { framework: 'flutter' },
            metadata: {
              primaryLocale: 'en-US',
              locales: { 'en-US': { name: 'Agentship Fixture' } },
            },
          }),
        );
        const outcome = await runBuild({ repoRoot: root, platform: 'ios', profile: 'default' });
        console.log(`built ${outcome.artifact.path} in ${Math.round(outcome.durationMs / 1000)}s`);
        expect(outcome.artifact.kind).toBe('ipa');
        // The .ipa's own Info.plist is the authority, and it is what the check reads.
        expect(outcome.artifact.version).toBe('1.2.3');
        expect(outcome.artifact.buildNumber).toBe('45');
        expect(outcome.artifact.bundleId).toBe('com.agentship.fixture');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    45 * 60_000,
  );
});

function androidManifest(options: {
  version: string;
  buildNumber: string;
  framework?: 'flutter' | 'android-native';
  keystore?: { path: string; alias: string; credentialProfile: string };
}) {
  return ManifestSchema.parse({
    version: 1,
    app: { name: 'Agentship Fixture' },
    stores: { google: { packageName: 'com.agentship.fixture' } },
    release: { version: options.version, buildNumber: options.buildNumber },
    build: {
      framework: options.framework ?? 'flutter',
      android: {
        module: 'app',
        ...(options.keystore === undefined ? {} : { keystore: options.keystore }),
      },
    },
    metadata: { primaryLocale: 'en-US', locales: { 'en-US': { name: 'Agentship Fixture' } } },
  });
}

async function createFlutterFixture(
  flutter: string,
  platforms: readonly string[] = ['android'],
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'agentship-e2e-'));
  const result = await runHostTool(flutter, {
    args: [
      'create',
      '--platforms',
      platforms.join(','),
      '--org',
      'com.agentship',
      '--project-name',
      'fixture',
      'fixture',
    ],
    cwd: parent,
    timeoutMs: 10 * 60_000,
  });
  if (result.exitCode !== 0) throw new Error(`flutter create failed: ${result.stderr}`);
  return join(parent, 'fixture');
}

/** Creates the upload keystore, optionally wiring it into the project the Flutter way. */
async function writeKeystore(root: string, options: { intoProject: boolean }): Promise<string> {
  const keytool = await findHostTool('keytool');
  if (keytool === undefined) throw new Error('keytool is required for this test');
  const path = join(root, 'upload.jks');
  const result = await runHostTool(keytool, {
    args: [
      '-genkeypair',
      '-keystore',
      path,
      '-alias',
      'upload',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10950',
      '-dname',
      'CN=Agentship Fixture, OU=Upload, O=com.agentship.fixture, C=US',
      '-storetype',
      'PKCS12',
    ],
    cwd: root,
    timeoutMs: 120_000,
    stdin: `${KEYSTORE_PASSWORD}\n${KEYSTORE_PASSWORD}\n`,
  });
  if (result.exitCode !== 0) throw new Error(`keytool failed: ${result.stderr}`);

  if (options.intoProject) {
    await writeFile(
      join(root, 'android', 'key.properties'),
      `storePassword=${KEYSTORE_PASSWORD}\nkeyPassword=${KEYSTORE_PASSWORD}\nkeyAlias=upload\nstoreFile=${path}\n`,
    );
    await addSigningConfig(root);
  }
  return path;
}

/** The signing setup Flutter's own release documentation describes. */
async function addSigningConfig(root: string): Promise<void> {
  const path = join(root, 'android/app/build.gradle.kts');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    `import java.util.Properties
import java.io.FileInputStream

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) keystoreProperties.load(FileInputStream(keystorePropertiesFile))

${source.replace(
  /buildTypes \{[\s\S]*?\n {4}\}/,
  `signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["keyPassword"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["storePassword"] as String
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }`,
)}`,
  );
}

/** Leaves the release build type with no signing configuration at all. */
async function removeSigningConfig(root: string): Promise<void> {
  const path = join(root, 'android/app/build.gradle.kts');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    source.replace(
      /buildTypes \{[\s\S]*?\n {4}\}/,
      'buildTypes {\n        release {\n        }\n    }',
    ),
  );
}

async function expectSignedWith(path: string, alias: string): Promise<void> {
  const names = (await listZipEntries(path)).map((entry) => entry.name);
  expect(names).toContain(`META-INF/${alias}.RSA`);
  expect(names).toContain('META-INF/MANIFEST.MF');
}
