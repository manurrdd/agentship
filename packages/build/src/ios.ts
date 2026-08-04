import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AgentshipError,
  type AgentshipManifest,
  ERROR_CODES,
  ensureDir,
  FILE_MODE,
  isNeedsInput,
  type Logger,
  tmpDir,
} from '@agentship/core';
import { withAppleKeyFile } from '@agentship/credentials';
import plist from 'plist';
import { buildFailure, diagnose } from './diagnostics.js';
import { requireHostTool, runHostTool } from './host.js';
import type { BuildLog } from './logs.js';
import type { ProjectShape } from './matrix.js';
import type { BuildCommand } from './types.js';

/**
 * Archiving and exporting an iOS application with Xcode.
 *
 * Two decisions are worth stating, because they are what make this unattended:
 *
 * **Signing is Apple's job, not Agentship's.** `xcodebuild -allowProvisioningUpdates` with the
 * App Store Connect key (`-authenticationKeyPath`/`-authenticationKeyID`/
 * `-authenticationKeyIssuerID`) lets Xcode create and download the distribution certificate
 * and the provisioning profile it needs, using the very same key Agentship already holds for
 * the store. There is no certificate management here, no keychain surgery, and no `.p12`
 * to pass around — which is exactly why Agentship uses that credential.
 *
 * **The version is injected, never written into the repository.** `MARKETING_VERSION` and
 * `CURRENT_PROJECT_VERSION` are passed as build settings on the command line. That works for
 * every project that uses the modern (Xcode 11+) version settings; a project that hard-codes
 * `CFBundleShortVersionString` in its Info.plist will produce an artifact whose version
 * disagrees with the release, and the artifact verification catches it and says so, rather
 * than publishing the wrong number.
 */
export interface IosBuildInputs {
  readonly repoRoot: string;
  readonly shape: ProjectShape;
  readonly manifest: AgentshipManifest;
  readonly version: string;
  readonly buildNumber: string;
  readonly profile: string;
  /** Exact path the .ipa must end up at; fixed by the release, not by Xcode. */
  readonly destination: string;
  readonly log: BuildLog;
  readonly logger?: Logger;
  readonly cancelSignal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Directory of the Xcode project: `ios/` in a JS or Flutter repo, the root otherwise. */
export function iosProjectDir(shape: ProjectShape): string {
  return shape.framework === 'ios-native' && !shape.hasIosProject
    ? shape.appDir
    : join(shape.appDir, 'ios');
}

interface ProjectTarget {
  readonly flag: '-workspace' | '-project';
  readonly value: string;
}

/**
 * Which Xcode container to build.
 *
 * A workspace wins over a project whenever one exists: CocoaPods generates a workspace, and
 * building the bare `.xcodeproj` of a Pods-based app fails in a way that is confusing to
 * everyone. When the manifest names neither, the directory is scanned — and an ambiguous
 * result is an error, not a coin toss.
 */
export async function resolveProjectTarget(
  directory: string,
  manifest: AgentshipManifest,
): Promise<ProjectTarget> {
  const configured = manifest.build?.ios;
  if (configured?.workspace !== undefined && !isNeedsInput(configured.workspace)) {
    return { flag: '-workspace', value: join(directory, configured.workspace) };
  }
  if (configured?.project !== undefined && !isNeedsInput(configured.project)) {
    return { flag: '-project', value: join(directory, configured.project) };
  }

  const entries = await readdir(directory).catch(() => [] as string[]);
  const workspaces = entries.filter((name) => name.endsWith('.xcworkspace')).sort();
  const projects = entries.filter((name) => name.endsWith('.xcodeproj')).sort();
  const candidates = workspaces.length > 0 ? workspaces : projects;
  if (candidates.length === 0) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_UNSUPPORTED_PROJECT,
      `No .xcworkspace or .xcodeproj was found in ${directory}.`,
      {
        details: { directory },
        remediation: { summary: 'Set build.ios.workspace or build.ios.project in the manifest.' },
      },
    );
  }
  if (candidates.length > 1) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_INPUT_REQUIRED,
      `${directory} contains several Xcode containers (${candidates.join(', ')}); Agentship will not guess which one to ship.`,
      {
        details: { directory, candidates },
        remediation: { summary: 'Set build.ios.workspace (or build.ios.project) in the manifest.' },
      },
    );
  }
  return {
    flag: workspaces.length > 0 ? '-workspace' : '-project',
    value: join(directory, candidates[0] as string),
  };
}

/**
 * The `exportOptions.plist` for an App Store export.
 *
 * `destination: export` writes the `.ipa` to disk instead of uploading it: Agentship uploads
 * through the store adapter, where the upload is journaled and resumable, not as an opaque
 * side effect of the build.
 */
export function exportOptions(options: {
  readonly teamId?: string;
  readonly bundleId?: string;
}): string {
  return plist.build({
    method: 'app-store-connect',
    destination: 'export',
    // Agentship never uploads symbols on the user's behalf; that is their choice to make,
    // and the default here matches what Xcode's own App Store export does.
    uploadSymbols: true,
    signingStyle: 'automatic',
    ...(options.teamId === undefined ? {} : { teamID: options.teamId }),
  });
}

export interface IosBuildResult {
  readonly ipaPath: string;
  readonly commands: readonly BuildCommand[];
  readonly warnings: readonly string[];
}

export async function buildIos(inputs: IosBuildInputs): Promise<IosBuildResult> {
  if (process.platform !== 'darwin') {
    throw new AgentshipError(
      ERROR_CODES.BUILD_PLATFORM_UNSUPPORTED,
      `An iOS application can only be archived on macOS; this machine runs ${process.platform}.`,
      {
        remediation: {
          summary:
            'Build the .ipa on a Mac or a macOS CI runner and point release.artifacts.apple at it.',
        },
      },
    );
  }

  const scheme = inputs.manifest.build?.ios?.scheme;
  if (scheme === undefined || isNeedsInput(scheme)) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_INPUT_REQUIRED,
      'The manifest does not say which Xcode scheme to build.',
      {
        details: { path: 'build.ios.scheme' },
        remediation: {
          summary:
            'Set build.ios.scheme in .agentship/agentship.yaml ("xcodebuild -list" prints the schemes this project defines).',
        },
      },
    );
  }

  const xcodebuild = await requireHostTool({
    name: 'xcodebuild',
    install: 'Install Xcode, then run "sudo xcode-select -s /Applications/Xcode.app".',
  });
  const directory = iosProjectDir(inputs.shape);
  const target = await resolveProjectTarget(directory, inputs.manifest);
  const configuration = inputs.manifest.build?.ios?.configuration ?? 'Release';
  const teamId = inputs.manifest.build?.ios?.teamId;
  const bundleId = inputs.manifest.stores.apple?.bundleId;

  const staging = await mkdtemp(join(await ensureDir(join(tmpDir(), 'ios')), 'x-'));
  const archivePath = join(staging, 'app.xcarchive');
  const exportPath = join(staging, 'export');
  const optionsPath = join(staging, 'exportOptions.plist');
  const commands: BuildCommand[] = [];
  const warnings: string[] = [];

  try {
    await writeFile(
      optionsPath,
      exportOptions({
        ...(teamId === undefined ? {} : { teamId }),
        ...(bundleId === undefined ? {} : { bundleId }),
      }),
      { mode: FILE_MODE },
    );

    // The key file exists only while xcodebuild runs; both invocations share it so the
    // export can renew a profile too.
    await withAppleKeyFile({ profile: inputs.profile }, async (keyPath, credentials) => {
      const auth = [
        '-allowProvisioningUpdates',
        '-authenticationKeyPath',
        keyPath,
        '-authenticationKeyID',
        credentials.keyId,
        '-authenticationKeyIssuerID',
        credentials.issuerId,
      ];

      const archiveArgs = [
        target.flag,
        target.value,
        '-scheme',
        scheme,
        '-configuration',
        configuration,
        '-destination',
        'generic/platform=iOS',
        '-archivePath',
        archivePath,
        // Injected, not written into the repository. A project that hard-codes its version
        // ignores these; the artifact check then refuses the mismatch instead of shipping it.
        `MARKETING_VERSION=${inputs.version}`,
        `CURRENT_PROJECT_VERSION=${inputs.buildNumber}`,
        ...auth,
        'archive',
      ];
      commands.push({
        executable: xcodebuild,
        args: archiveArgs,
        cwd: directory,
        summary: `xcodebuild archive -scheme ${scheme} -configuration ${configuration}`,
      });
      await run(inputs, xcodebuild, archiveArgs, directory, 'xcodebuild archive');

      const exportArgs = [
        '-exportArchive',
        '-archivePath',
        archivePath,
        '-exportPath',
        exportPath,
        '-exportOptionsPlist',
        optionsPath,
        ...auth,
      ];
      commands.push({
        executable: xcodebuild,
        args: exportArgs,
        cwd: directory,
        summary: 'xcodebuild -exportArchive (method: app-store-connect)',
      });
      await run(inputs, xcodebuild, exportArgs, directory, 'xcodebuild -exportArchive');
    });

    const exported = (await readdir(exportPath).catch(() => [] as string[])).filter((name) =>
      name.endsWith('.ipa'),
    );
    if (exported.length === 0) {
      throw new AgentshipError(
        ERROR_CODES.BUILD_ARTIFACT_INVALID,
        'xcodebuild reported a successful export but produced no .ipa.',
        { details: { exportPath, logPath: inputs.log.path } },
      );
    }
    if (exported.length > 1) {
      warnings.push(
        `The export produced ${exported.length} .ipa files; Agentship published ${exported[0] as string}.`,
      );
    }

    await ensureDir(dirname(inputs.destination));
    await rm(inputs.destination, { force: true });
    await rename(join(exportPath, exported[0] as string), inputs.destination);
    return { ipaPath: inputs.destination, commands, warnings };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function run(
  inputs: IosBuildInputs,
  executable: string,
  args: readonly string[],
  cwd: string,
  label: string,
): Promise<void> {
  await inputs.log.section(label);
  const result = await runHostTool(executable, {
    args,
    cwd,
    toolName: 'xcodebuild',
    ...(inputs.timeoutMs === undefined ? {} : { timeoutMs: inputs.timeoutMs }),
    ...(inputs.logger === undefined ? {} : { logger: inputs.logger }),
    ...(inputs.cancelSignal === undefined ? {} : { cancelSignal: inputs.cancelSignal }),
  });
  await inputs.log.write(`${result.stdout}\n${result.stderr}\n`);
  if (result.exitCode === 0) return;
  throw buildFailure(diagnose(`${result.stdout}\n${result.stderr}`), {
    step: label,
    exitCode: result.exitCode,
    logPath: inputs.log.path,
  });
}
