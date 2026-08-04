import { stat } from 'node:fs/promises';
import {
  type ActionDraft,
  AgentshipError,
  type ArtifactRecord,
  checkArtifact,
  type DifferInput,
  fileSha256,
  isNeedsInput,
  type LocalActionResult,
  type LocalActionRunner,
  loadManifest,
  type PendingOperation,
  plannedArtifactPath,
  type ResourceDiffer,
  readArtifacts,
  recordArtifact,
  resolveArtifactPath,
  type Store,
} from '@agentship/core';
import { runBuild } from './build.js';
import { buildSupport, detectProject } from './matrix.js';
import type { BuildPlatform } from './types.js';

/**
 * The differ that decides whether the release needs a build.
 *
 * It answers one question — "is there an artifact this release could publish right now?" —
 * and the answer is always re-derived from the filesystem, never from a flag. A recorded
 * artifact must still exist, still hash to what was recorded, and still declare the version
 * and build number the manifest asks for. Anything else and the build action reappears.
 *
 * That is what makes a build resumable without any bookkeeping of its own: it converges for
 * exactly the same reason a store action does. The store's answer to "did the upload land?"
 * is a fresh snapshot; the disk's answer to "did the build land?" is a fresh hash.
 */
export const BUILD_LOCAL_KIND = 'build';

const PLATFORM_BY_STORE: Readonly<Record<Store, BuildPlatform>> = {
  apple: 'ios',
  google: 'android',
};

export function buildDiffer(store: Store): ResourceDiffer {
  const platform = PLATFORM_BY_STORE[store];
  return {
    store,
    resource: 'build',
    async plan(input: DifferInput): Promise<readonly ActionDraft[]> {
      const release = input.manifest.release;
      const needsInput: string[] = [];
      if (isNeedsInput(release.version)) needsInput.push('release.version');
      if (release.buildNumber === undefined || isNeedsInput(release.buildNumber)) {
        needsInput.push('release.buildNumber');
      }

      // A build number the store already carries means the binary exists remotely; there is
      // nothing left to produce, whatever is or is not on this disk.
      const buildNumber = release.buildNumber;
      if (
        buildNumber !== undefined &&
        !isNeedsInput(buildNumber) &&
        input.state.builds.some((build) => build.buildNumber === buildNumber)
      ) {
        return [];
      }

      const supplied = await suppliedArtifact(input, store);
      if (supplied.record !== undefined) return [];
      const existing = await usableRecord(input, store, release.version, buildNumber);
      if (existing !== undefined) return [];

      const shape = await detectProject(input.repoRoot, input.manifest);
      const support = await buildSupport(input.manifest, shape, platform);
      if (support.status === 'unsupported' || support.status === 'host_unsupported') {
        // Not a failure to plan around: the user has to supply the artifact, and saying so
        // once during planning beats failing during an apply.
        return [
          {
            kind: 'build',
            target: `${platform}/${release.version}`,
            operation: 'buildArtifact',
            summary: `Build the ${platform} artifact for ${release.version} (${support.status === 'host_unsupported' ? 'not possible on this machine' : 'not supported for this project'})`,
            diff: [
              {
                path: `build.${platform}`,
                before: describe(supplied.reason ?? existingReason(undefined)),
                after: 'a signed artifact',
                note: support.detail,
              },
            ],
            needsInput: [`release.artifacts.${store}`],
            riskNotes: [support.remediation ?? support.detail],
          },
        ];
      }

      const inputPaths = [...needsInput, ...(support.needsInput ?? [])];
      const previous = (await readArtifacts(input.repoRoot)).artifacts[store];
      return [
        {
          kind: 'build',
          target: `${platform}/${release.version}`,
          operation: 'buildArtifact',
          summary: `Build and sign the ${platform} artifact for ${release.version} (${buildNumber ?? '?'}) with ${support.builder}`,
          diff: [
            {
              path: `artifacts.${store}`,
              ...(previous === undefined
                ? {}
                : { before: `${previous.version} (${previous.buildNumber})` }),
              after: `${release.version} (${buildNumber ?? '?'})`,
              ...(supplied.reason === undefined ? {} : { note: supplied.reason }),
            },
          ],
          ...(inputPaths.length > 0
            ? { needsInput: [...new Set(inputPaths)] }
            : {
                local: {
                  kind: BUILD_LOCAL_KIND,
                  payload: {
                    platform,
                    version: release.version,
                    buildNumber: buildNumber as string,
                    builder: support.builder,
                    // The path is a function of the release, so the upload action can be
                    // planned against it before this build has produced anything.
                    destination: plannedArtifactPath(
                      input.repoRoot,
                      store,
                      platform === 'ios'
                        ? 'ipa'
                        : (input.manifest.build?.android?.artifact ?? 'aab'),
                      release.version,
                      buildNumber as string,
                    ),
                  },
                },
              }),
          riskNotes: [
            'Building runs this repository’s own build scripts on this machine. Agentship strips its own configuration from the build environment, but the code that runs is the project’s.',
          ],
        },
      ];
    },
  };
}

/** The user's own artifact, when the manifest points at one. */
async function suppliedArtifact(
  input: DifferInput,
  store: Store,
): Promise<{ record?: ArtifactRecord; reason?: string }> {
  const declared = input.manifest.release.artifacts?.[store];
  if (declared === undefined) return {};
  const path = resolveArtifactPath(input.repoRoot, declared.path);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    return { reason: `release.artifacts.${store}.path points at ${path}, which does not exist.` };
  }
  if (declared.sha256 !== undefined) {
    const actual = await fileSha256(path);
    if (actual !== declared.sha256) {
      return {
        reason: `release.artifacts.${store} pins a SHA-256 that ${path} no longer matches.`,
      };
    }
  }
  return {
    record: {
      store,
      path,
      kind: declared.kind,
      sha256: declared.sha256 ?? '',
      sizeBytes: info.size,
      version: input.manifest.release.version,
      buildNumber: input.manifest.release.buildNumber ?? '',
      builder: 'supplied',
      builtAt: info.mtime.toISOString(),
    },
  };
}

/** A previously built artifact that is still exactly what the release asks for. */
async function usableRecord(
  input: DifferInput,
  store: Store,
  version: string,
  buildNumber: string | undefined,
): Promise<ArtifactRecord | undefined> {
  const record = (await readArtifacts(input.repoRoot)).artifacts[store];
  if (record === undefined) return undefined;
  if (record.version !== version) return undefined;
  if (buildNumber !== undefined && record.buildNumber !== buildNumber) return undefined;
  const check = await checkArtifact(record);
  return check.valid ? record : undefined;
}

function existingReason(record: ArtifactRecord | undefined): string {
  return record === undefined ? 'no artifact' : `${record.version} (${record.buildNumber})`;
}

function describe(reason: string): string {
  return reason;
}

/**
 * The runner the kernel calls to perform a `build` action.
 *
 * It reports failures as data rather than throwing, so a build that fails becomes a normal
 * failed outcome — with its diagnosis and the console work it uncovered — and `resume`
 * picks up from there. The only thing that escapes is a genuine crash, which is exactly the
 * case the write-ahead journal exists for.
 */
export function buildRunner(): LocalActionRunner {
  return async ({ op, repoRoot, context, dryRun }): Promise<LocalActionResult> => {
    const payload = op.payload as {
      platform: BuildPlatform;
      version: string;
      buildNumber: string;
      builder: string;
    };
    if (dryRun) {
      return {
        ok: true,
        changed: false,
        detail: `Would build the ${payload.platform} artifact for ${payload.version} (${payload.buildNumber}) with ${payload.builder}. Nothing was compiled.`,
      };
    }

    try {
      const manifest = await loadManifest(repoRoot);
      const outcome = await runBuild({
        repoRoot,
        platform: payload.platform,
        profile: context.profile,
        version: payload.version,
        buildNumber: payload.buildNumber,
        manifest,
        logger: context.logger,
        ...(context.cancelSignal === undefined ? {} : { cancelSignal: context.cancelSignal }),
      });
      return {
        ok: true,
        changed: true,
        detail: `${outcome.artifact.path} (${outcome.artifact.sizeBytes} bytes, sha256 ${outcome.artifact.sha256.slice(0, 12)}…) in ${Math.round(outcome.durationMs / 1000)}s. Log: ${outcome.logPath}`,
        warnings: outcome.warnings,
      };
    } catch (error) {
      if (!AgentshipError.is(error)) throw error;
      const pending = error.details?.['pendingOperation'] as PendingOperation | undefined;
      return {
        ok: false,
        changed: false,
        errorCode: error.code,
        errorMessage: error.message,
        ...(pending === undefined ? {} : { pending: [pending] }),
      };
    }
  };
}

/** Records an artifact the user built elsewhere, so the plan stops asking for a build. */
export async function adoptArtifact(
  repoRoot: string,
  record: Omit<ArtifactRecord, 'sha256' | 'sizeBytes' | 'builtAt'>,
): Promise<ArtifactRecord> {
  const info = await stat(record.path);
  const complete: ArtifactRecord = {
    ...record,
    sha256: await fileSha256(record.path),
    sizeBytes: info.size,
    builtAt: new Date().toISOString(),
  };
  await recordArtifact(repoRoot, complete);
  return complete;
}
