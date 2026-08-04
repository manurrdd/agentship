import { readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AgentshipError,
  type AgentshipManifest,
  ERROR_CODES,
  ensureDir,
  type Logger,
} from '@agentship/core';
import { withAppleKeyFile } from '@agentship/credentials';
import { buildFailure, diagnose } from './diagnostics.js';
import { requireHostTool, runHostTool } from './host.js';
import { detectKeystore } from './keystore.js';
import type { BuildLog } from './logs.js';
import type { ProjectShape } from './matrix.js';
import type { BuildCommand, BuildPlatform } from './types.js';

/**
 * Building a Flutter app.
 *
 * Flutter drives Xcode and Gradle itself, so Agentship's job here is narrower than for the
 * native builders: supply the version, supply the signing material the same way, and read
 * back the artifact from where Flutter puts it.
 *
 * `--build-name`/`--build-number` are Flutter's own version injection and they work on both
 * platforms, which is the one place Flutter is easier than the native path. iOS signing
 * still goes through the App Store Connect key: `flutter build ipa` accepts an
 * `--export-options-plist`, but automatic signing needs the key visible to the underlying
 * `xcodebuild`, so the key file is materialised around the whole invocation exactly as the
 * native iOS builder does.
 */
export interface FlutterBuildInputs {
  readonly repoRoot: string;
  readonly shape: ProjectShape;
  readonly manifest: AgentshipManifest;
  readonly platform: BuildPlatform;
  readonly version: string;
  readonly buildNumber: string;
  readonly profile: string;
  /** Exact path the artifact must end up at; fixed by the release, not by Flutter. */
  readonly destination: string;
  readonly log: BuildLog;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface FlutterBuildResult {
  readonly artifactPath: string;
  readonly commands: readonly BuildCommand[];
  readonly warnings: readonly string[];
}

/** Where `flutter build` writes each artifact, relative to the app directory. */
export function flutterOutputDir(appDir: string, platform: BuildPlatform): string {
  return platform === 'ios'
    ? join(appDir, 'build', 'ios', 'ipa')
    : join(appDir, 'build', 'app', 'outputs', 'bundle', 'release');
}

export async function buildFlutter(inputs: FlutterBuildInputs): Promise<FlutterBuildResult> {
  if (inputs.platform === 'ios' && process.platform !== 'darwin') {
    throw new AgentshipError(
      ERROR_CODES.BUILD_PLATFORM_UNSUPPORTED,
      `flutter build ipa needs Xcode and therefore macOS; this machine runs ${process.platform}.`,
      {
        remediation: {
          summary: 'Build the .ipa on a Mac and point release.artifacts.apple at it.',
        },
      },
    );
  }

  const flutter = await requireHostTool({
    name: 'flutter',
    install: 'Install the Flutter SDK and make sure "flutter --version" works.',
  });
  const flutterConfig = inputs.manifest.build?.flutter;
  const args = [
    'build',
    inputs.platform === 'ios' ? 'ipa' : 'appbundle',
    '--release',
    `--build-name=${inputs.version}`,
    `--build-number=${inputs.buildNumber}`,
    ...(flutterConfig?.flavor === undefined ? [] : ['--flavor', flutterConfig.flavor]),
    ...(flutterConfig?.target === undefined ? [] : ['--target', flutterConfig.target]),
    ...(inputs.platform === 'ios' ? ['--export-method', 'app-store'] : []),
  ];

  const warnings: string[] = [];
  const commands: BuildCommand[] = [
    {
      executable: flutter,
      args,
      cwd: inputs.shape.appDir,
      summary: `flutter ${args.slice(0, 2).join(' ')} --build-name=${inputs.version} --build-number=${inputs.buildNumber}`,
    },
  ];

  const outputs = flutterOutputDir(inputs.shape.appDir, inputs.platform);
  await rm(outputs, { recursive: true, force: true }).catch(() => undefined);

  const invoke = async (extraEnv: Readonly<Record<string, string>>): Promise<void> => {
    await inputs.log.section(`flutter ${args.slice(0, 2).join(' ')}`);
    const result = await runHostTool(flutter, {
      args,
      cwd: inputs.shape.appDir,
      env: extraEnv,
      toolName: 'flutter',
      ...(inputs.timeoutMs === undefined ? {} : { timeoutMs: inputs.timeoutMs }),
      ...(inputs.logger === undefined ? {} : { logger: inputs.logger }),
      ...(inputs.cancelSignal === undefined ? {} : { cancelSignal: inputs.cancelSignal }),
    });
    await inputs.log.write(`${result.stdout}\n${result.stderr}\n`);
    if (result.exitCode !== 0) {
      throw buildFailure(diagnose(`${result.stdout}\n${result.stderr}`), {
        step: 'flutter build',
        exitCode: result.exitCode,
        logPath: inputs.log.path,
      });
    }
  };

  if (inputs.platform === 'ios') {
    await withAppleKeyFile({ profile: inputs.profile }, async (keyPath, credentials) => {
      // Flutter forwards these to xcodebuild, which is what makes automatic signing work
      // without a certificate ever being managed by hand.
      await invoke({
        APP_STORE_CONNECT_API_KEY_PATH: keyPath,
        APP_STORE_CONNECT_API_KEY_ID: credentials.keyId,
        APP_STORE_CONNECT_API_ISSUER_ID: credentials.issuerId,
      });
    });
  } else {
    const packageName = inputs.manifest.stores.google?.packageName ?? 'unknown.package';
    const keystore = await detectKeystore(inputs.shape.appDir, packageName, inputs.manifest);
    // `flutter build appbundle` owns the Gradle invocation and forwards no init script, so
    // Agentship cannot inject a signing config the way it does for a plain Gradle build. The
    // Flutter-native answer is `android/key.properties`, which the template already reads —
    // so that is what Agentship asks for, instead of pretending to sign and shipping a
    // debug-signed bundle Play would reject.
    if (keystore.origin !== 'project') {
      throw new AgentshipError(
        ERROR_CODES.BUILD_SIGNING_FAILED,
        'This Flutter project has no release signing configuration, and Agentship cannot inject one into a `flutter build` invocation.',
        {
          store: 'google',
          details: { appDir: inputs.shape.appDir, keystore: keystore.detail },
          remediation: {
            summary:
              'Add android/key.properties (storeFile, storePassword, keyAlias, keyPassword) and the matching signingConfig, as the Flutter release documentation describes.',
            steps: [
              'Ask Agentship to generate an upload keystore if you do not have one; it stores the password in the OS keyring and tells you where the file is.',
              'Create android/key.properties pointing at that keystore, and keep it out of git.',
              'Re-run the build: Agentship will then see the project signs itself and inject nothing.',
            ],
            docsUrl: 'https://docs.flutter.dev/deployment/android#signing-the-app',
          },
        },
      );
    }
    warnings.push(
      'The Flutter project signs its own release builds (android/key.properties); Agentship injected nothing.',
    );
    await invoke({});
  }

  const wanted = inputs.platform === 'ios' ? '.ipa' : '.aab';
  const entries = (await readdir(outputs).catch(() => [] as string[]))
    .filter((name) => name.endsWith(wanted))
    .sort();
  const produced = entries[0];
  if (produced === undefined) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `flutter build reported success but no ${wanted} appeared in ${outputs}.`,
      { details: { outputs, logPath: inputs.log.path } },
    );
  }

  await ensureDir(dirname(inputs.destination));
  await rm(inputs.destination, { force: true });
  await rename(join(outputs, produced), inputs.destination);
  return { artifactPath: inputs.destination, commands, warnings };
}
