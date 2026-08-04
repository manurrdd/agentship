import { readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AgentshipError,
  type AgentshipManifest,
  ERROR_CODES,
  ensureDir,
  type Logger,
  pathExists,
} from '@agentship/core';
import { buildFailure, diagnose } from './diagnostics.js';
import { runHostTool } from './host.js';
import { detectKeystore, resolveSigning, withSigningInjection } from './keystore.js';
import type { BuildLog } from './logs.js';
import type { ProjectShape } from './matrix.js';
import type { BuildCommand } from './types.js';

/**
 * Building an Android app bundle with the project's own Gradle wrapper.
 *
 * The wrapper, never a global `gradle`: the wrapper pins the Gradle version the project was
 * built and tested with, and substituting another one produces an artifact the user cannot
 * reproduce locally. If the wrapper is missing, Agentship says so instead of improvising.
 *
 * Version injection is honest about its limits. `-PversionCode`/`-PversionName` only reach
 * the build if the project's Gradle files read those properties — many do, because that is
 * the convention CI has used for a decade, and Flutter's template does it too. When they do
 * not, the bundle carries whatever the project hard-codes, and Play rejects a duplicate
 * versionCode at upload with a clear message. Agentship never edits the user's Gradle files to
 * force the issue.
 */
export interface AndroidBuildInputs {
  readonly repoRoot: string;
  readonly shape: ProjectShape;
  readonly manifest: AgentshipManifest;
  readonly version: string;
  readonly buildNumber: string;
  readonly profile: string;
  /** Exact path the artifact must end up at; fixed by the release, not by Gradle. */
  readonly destination: string;
  readonly log: BuildLog;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Directory holding the Gradle wrapper: `android/` in a JS repo, the root in a native one. */
export async function gradleDir(shape: ProjectShape): Promise<string> {
  const nested = join(shape.appDir, 'android');
  return (await pathExists(join(nested, 'gradlew'))) ? nested : shape.appDir;
}

function capitalize(value: string): string {
  return value === '' ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

/**
 * The Gradle task name for a module, flavour and build type.
 *
 * Android's task naming is `:<module>:bundle<Flavor><BuildType>` (or `assemble…` for an
 * APK), and getting it wrong produces "task not found" — which the diagnostics turn into
 * "check build.android.* in your manifest" rather than a Gradle stack trace.
 */
export function gradleTask(options: {
  readonly module: string;
  readonly flavor?: string;
  readonly buildType: string;
  readonly artifact: 'aab' | 'apk';
}): string {
  const verb = options.artifact === 'aab' ? 'bundle' : 'assemble';
  const variant = `${capitalize(options.flavor ?? '')}${capitalize(options.buildType)}`;
  return `:${options.module}:${verb}${variant}`;
}

/**
 * Where AGP writes the artifact for a variant — by convention.
 *
 * The convention is `<module>/build/outputs/<bundle|apk>/<variant>/`, but a project may
 * relocate `buildDir` (Flutter's template does, to a shared `build/` at the repository
 * root), so this is where the search *starts*, not where it stops. Guessing one path and
 * failing when a project is laid out differently would be exactly the kind of brittleness
 * that makes a build tool untrustworthy.
 */
export function outputDirFor(options: {
  readonly gradleDir: string;
  readonly module: string;
  readonly flavor?: string;
  readonly buildType: string;
  readonly artifact: 'aab' | 'apk';
}): string {
  return join(
    options.gradleDir,
    options.module,
    'build',
    'outputs',
    outputKind(options.artifact),
    variantDir(options),
  );
}

function outputKind(artifact: 'aab' | 'apk'): string {
  return artifact === 'aab' ? 'bundle' : 'apk';
}

function variantDir(options: { readonly flavor?: string; readonly buildType: string }): string {
  return options.flavor === undefined
    ? options.buildType
    : `${options.flavor}${capitalize(options.buildType)}`;
}

/**
 * Every place this project might have put the artifact, in order of confidence.
 *
 * Two conventions cover everything in practice: AGP's own `<module>/build/...` and a
 * relocated root `build/<module>/...`. Both are checked against the same variant path, so a
 * stray artifact from another variant is never picked up.
 */
export function outputCandidates(options: {
  readonly gradleDir: string;
  readonly repoRoot: string;
  readonly appDir: string;
  readonly module: string;
  readonly flavor?: string;
  readonly buildType: string;
  readonly artifact: 'aab' | 'apk';
}): readonly string[] {
  const tail = join('outputs', outputKind(options.artifact), variantDir(options));
  return [
    join(options.gradleDir, options.module, 'build', tail),
    join(options.appDir, 'build', options.module, tail),
    join(options.gradleDir, 'build', options.module, tail),
    join(options.repoRoot, 'build', options.module, tail),
  ];
}

export interface AndroidBuildResult {
  readonly artifactPath: string;
  readonly commands: readonly BuildCommand[];
  readonly warnings: readonly string[];
}

export async function buildAndroid(inputs: AndroidBuildInputs): Promise<AndroidBuildResult> {
  const android = inputs.manifest.build?.android;
  const module = android?.module ?? 'app';
  const buildType = android?.buildType ?? 'release';
  const artifact = android?.artifact ?? 'aab';
  const flavor = android?.flavor;
  const packageName = inputs.manifest.stores.google?.packageName ?? 'unknown.package';

  const directory = await gradleDir(inputs.shape);
  const wrapper = join(directory, 'gradlew');
  if (!(await pathExists(wrapper))) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_TOOL_MISSING,
      `This project has no Gradle wrapper at ${wrapper}.`,
      {
        details: { directory },
        remediation: {
          summary:
            'Commit the Gradle wrapper the project was created with. Agentship will not build with a globally installed gradle: it would use a different Gradle version than the project expects.',
        },
      },
    );
  }

  const task = gradleTask({
    module,
    ...(flavor === undefined ? {} : { flavor }),
    buildType,
    artifact,
  });
  const baseArgs = [
    task,
    // Read by every project that follows the standard CI convention; ignored otherwise,
    // which the artifact and the store's duplicate-versionCode check both catch.
    `-PversionName=${inputs.version}`,
    `-PversionCode=${inputs.buildNumber}`,
    '--no-daemon',
    '--console=plain',
    '--stacktrace',
  ];

  const keystore = await detectKeystore(inputs.shape.appDir, packageName, inputs.manifest);
  const signing = await resolveSigning(keystore, android?.keystore?.credentialProfile);
  const warnings: string[] = [];
  if (keystore.origin === 'project') {
    warnings.push(
      'The project signs its own release builds; Agentship injected no signing configuration.',
    );
  }

  const commands: BuildCommand[] = [];
  const candidates = outputCandidates({
    gradleDir: directory,
    repoRoot: inputs.repoRoot,
    appDir: inputs.shape.appDir,
    module,
    ...(flavor === undefined ? {} : { flavor }),
    buildType,
    artifact,
  });
  // A stale artifact from a previous build would be indistinguishable from a fresh one.
  for (const candidate of candidates) {
    await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
  }

  const invoke = async (args: readonly string[]): Promise<void> => {
    commands.push({
      executable: wrapper,
      args,
      cwd: directory,
      summary: `./gradlew ${task} (versionName=${inputs.version}, versionCode=${inputs.buildNumber})`,
    });
    await inputs.log.section(`gradlew ${task}`);
    const result = await runHostTool(wrapper, {
      args,
      cwd: directory,
      toolName: 'gradlew',
      ...(inputs.timeoutMs === undefined ? {} : { timeoutMs: inputs.timeoutMs }),
      ...(inputs.logger === undefined ? {} : { logger: inputs.logger }),
      ...(inputs.cancelSignal === undefined ? {} : { cancelSignal: inputs.cancelSignal }),
    });
    await inputs.log.write(`${result.stdout}\n${result.stderr}\n`);
    if (result.exitCode !== 0) {
      throw buildFailure(diagnose(`${result.stdout}\n${result.stderr}`), {
        step: `gradlew ${task}`,
        exitCode: result.exitCode,
        logPath: inputs.log.path,
      });
    }
  };

  if (signing === undefined) {
    await invoke(baseArgs);
  } else {
    await withSigningInjection(signing, async (injection) => {
      await invoke(['--init-script', injection.initScript, ...baseArgs]);
    });
  }

  let produced: string | undefined;
  for (const candidate of candidates) {
    produced = await newestArtifact(candidate, artifact);
    if (produced !== undefined) break;
  }
  if (produced === undefined) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `Gradle reported success but no .${artifact} appeared in any of ${candidates.join(', ')}.`,
      {
        details: { candidates, task, logPath: inputs.log.path },
        remediation: {
          summary:
            'Check that build.android.module, flavor and buildType match a variant this project defines.',
        },
      },
    );
  }

  await ensureDir(dirname(inputs.destination));
  await rm(inputs.destination, { force: true });
  await rename(produced, inputs.destination);
  return { artifactPath: inputs.destination, commands, warnings };
}

/** The most recently written artifact of the expected kind, since a variant may emit several. */
async function newestArtifact(directory: string, kind: 'aab' | 'apk'): Promise<string | undefined> {
  const entries = (await readdir(directory).catch(() => [] as string[])).filter((name) =>
    name.endsWith(`.${kind}`),
  );
  let best: { path: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (best === undefined || info.mtimeMs > best.mtimeMs) best = { path, mtimeMs: info.mtimeMs };
  }
  return best?.path;
}
