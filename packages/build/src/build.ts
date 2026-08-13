import { join } from 'node:path';
import {
  AgentshipError,
  type AgentshipManifest,
  type ArtifactKind,
  ERROR_CODES,
  isNeedsInput,
  type Logger,
  loadManifest,
  plannedArtifactPath,
  recordArtifact,
} from '@agentship/core';
import { buildAndroid } from './android.js';
import { verifyArtifact } from './artifact.js';
import { buildFlutter } from './flutter.js';
import { fingerprintBuildInputs } from './inputs.js';
import { buildIos } from './ios.js';
import { createBuildLog } from './logs.js';
import { builderFor, buildSupport, detectProject } from './matrix.js';
import type { BuilderId, BuildOutcome, BuildPlatform } from './types.js';
import { storeForPlatform } from './types.js';

/**
 * One build, end to end: decide, run, verify, record.
 *
 * The order is the point. Support is checked before anything runs, so an impossible build
 * fails in a second with an instruction instead of ten minutes in with a stack trace. The
 * artifact is verified against the release before it is recorded, so an artifact that
 * disagrees with the plan never becomes something the upload step will happily publish. And
 * the record — path, size, SHA-256, version, build number — is written last, which is what
 * makes the whole step idempotent: a second `plan` sees a usable artifact and drafts no
 * build at all.
 */
export interface RunBuildOptions {
  readonly repoRoot: string;
  readonly platform: BuildPlatform;
  readonly profile: string;
  /** Overrides the manifest's version, for a one-off build. */
  readonly version?: string;
  readonly buildNumber?: string;
  readonly outputDir?: string;
  readonly manifest?: AgentshipManifest;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
  readonly timeoutMs?: number;
}

function artifactKindFor(builder: BuilderId, manifest: AgentshipManifest): ArtifactKind {
  if (builder === 'ios-xcodebuild' || builder === 'flutter-ios') return 'ipa';
  if (builder === 'flutter-android') return 'aab';
  return manifest.build?.android?.artifact ?? 'aab';
}

export async function runBuild(options: RunBuildOptions): Promise<BuildOutcome> {
  const startedAt = new Date();
  const manifest = options.manifest ?? (await loadManifest(options.repoRoot));
  const shape = await detectProject(options.repoRoot, manifest);

  const support = await buildSupport(manifest, shape, options.platform);
  if (support.status !== 'supported') {
    throw new AgentshipError(
      support.status === 'host_unsupported'
        ? ERROR_CODES.BUILD_PLATFORM_UNSUPPORTED
        : support.status === 'tool_missing'
          ? ERROR_CODES.BUILD_TOOL_MISSING
          : support.status === 'needs_input'
            ? ERROR_CODES.BUILD_INPUT_REQUIRED
            : ERROR_CODES.BUILD_UNSUPPORTED_PROJECT,
      support.detail,
      {
        details: {
          builder: support.builder,
          platform: support.platform,
          ...(support.needsInput === undefined ? {} : { needsInput: support.needsInput }),
        },
        ...(support.remediation === undefined
          ? {}
          : { remediation: { summary: support.remediation } }),
      },
    );
  }

  const version = options.version ?? manifest.release.version;
  const buildNumber = options.buildNumber ?? manifest.release.buildNumber;
  if (isNeedsInput(version) || buildNumber === undefined || isNeedsInput(buildNumber)) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_INPUT_REQUIRED,
      'A build needs both release.version and release.buildNumber.',
      {
        details: { needsInput: ['release.version', 'release.buildNumber'] },
        remediation: { summary: 'Fill both in .agentship/agentship.yaml, then build again.' },
      },
    );
  }

  const builder = builderFor(shape, options.platform) as BuilderId;
  const store = storeForPlatform(options.platform);
  const kind = artifactKindFor(builder, manifest);
  // Fixed by the release rather than by the build tool: the upload action is planned against
  // this path before the build has produced anything to name.
  const destination =
    options.outputDir === undefined
      ? plannedArtifactPath(options.repoRoot, store, kind, version, buildNumber)
      : join(options.outputDir, `${store}-${version}-${buildNumber}.${kind}`);
  const log = await createBuildLog(options.platform, startedAt.toISOString());
  await log.write(
    `builder=${builder} version=${version} buildNumber=${buildNumber} appDir=${shape.appDir}\n`,
  );

  // Taken before the build runs: this is the state of the project the artifact will be built
  // from, and it is what decides whether the result may be reused later instead of rebuilt.
  const inputs = await fingerprintBuildInputs(shape.appDir);
  await log.write(
    inputs === undefined
      ? 'inputs=unfingerprinted (this artifact will never be reused)\n'
      : `inputs=${inputs.digest} files=${inputs.files} bytes=${inputs.bytes}\n`,
  );

  const shared = {
    repoRoot: options.repoRoot,
    shape,
    manifest,
    version,
    buildNumber,
    profile: options.profile,
    destination,
    log,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };

  const produced =
    builder === 'ios-xcodebuild'
      ? await buildIos(shared).then((r) => ({ path: r.ipaPath, ...r }))
      : builder === 'android-gradle'
        ? await buildAndroid(shared).then((r) => ({ path: r.artifactPath, ...r }))
        : await buildFlutter({ ...shared, platform: options.platform }).then((r) => ({
            path: r.artifactPath,
            ...r,
          }));

  const artifact = await verifyArtifact(produced.path, {
    store,
    kind,
    version,
    buildNumber,
    ...(store === 'apple'
      ? manifest.stores.apple?.bundleId === undefined ||
        isNeedsInput(manifest.stores.apple.bundleId)
        ? {}
        : { bundleId: manifest.stores.apple.bundleId }
      : manifest.stores.google?.packageName === undefined ||
          isNeedsInput(manifest.stores.google.packageName)
        ? {}
        : { bundleId: manifest.stores.google.packageName }),
    builder,
    logPath: log.path,
    ...(inputs === undefined ? {} : { inputsDigest: inputs.digest }),
  });

  await recordArtifact(options.repoRoot, artifact);
  await log.section('artifact');
  await log.write(
    `${artifact.path}\nsha256=${artifact.sha256}\nsize=${artifact.sizeBytes}\nversion=${artifact.version}\nbuildNumber=${artifact.buildNumber}\n`,
  );

  return {
    artifact,
    commands: produced.commands.map((command) => command.summary),
    logPath: log.path,
    durationMs: Date.now() - startedAt.getTime(),
    warnings: [
      ...produced.warnings,
      ...(artifact.unverified ?? []).map((note) => `Not verified — ${note}`),
    ],
  };
}
