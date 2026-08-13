import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AgentshipError, ERROR_CODES } from '../errors.js';
import { ensureDir, FILE_MODE, stateDir } from '../paths.js';
import type { Store } from '../types.js';

/**
 * The register of artifacts built on this machine: `.agentship/state/artifacts.json`.
 *
 * A build is the one step of a release that produces a file rather than a store change, so
 * it cannot be re-derived by asking the store what happened. The register is what makes it
 * resumable anyway: it records the bytes that were produced (path, size and SHA-256) next
 * to the version and build number they declare, and every consumer re-verifies the hash
 * before trusting the entry. A file that was moved, edited or rebuilt therefore invalidates
 * itself — the same "identity is content" rule the plan ids follow.
 *
 * It lives in `state/`, never in the manifest: the manifest is the desired state and goes
 * into git, while an artifact is an output of one machine at one moment.
 */
export const ARTIFACT_REGISTER_VERSION = 1;

export type ArtifactKind = 'ipa' | 'pkg' | 'aab' | 'apk';

export interface ArtifactRecord {
  readonly store: Store;
  /** Absolute path of the artifact on this machine. */
  readonly path: string;
  readonly kind: ArtifactKind;
  /** SHA-256 of the file contents, hex-encoded lowercase. */
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Marketing version read back from the artifact, or requested when unreadable. */
  readonly version: string;
  /** `CFBundleVersion` / `versionCode`. */
  readonly buildNumber: string;
  /** Application identifier the artifact declares, when it could be read. */
  readonly bundleId?: string;
  /** Id of the builder that produced it, e.g. `ios-xcodebuild`. */
  readonly builder: string;
  /**
   * Fingerprint of the source tree this was built from, when it could be taken.
   *
   * The artifact's own hash proves the file has not been touched; it says nothing about the
   * project. Without this, editing an asset and leaving the build number alone leaves the
   * previous artifact hashing correctly, so the build is skipped and the old binary is
   * published. A record with no fingerprint is never reused.
   */
  readonly inputsDigest?: string;
  readonly builtAt: string;
  /** Full build log, kept outside the repo. */
  readonly logPath?: string;
  /** What could not be verified inside the artifact, so nothing looks more certain than it is. */
  readonly unverified?: readonly string[];
}

export interface ArtifactRegister {
  readonly schemaVersion: typeof ARTIFACT_REGISTER_VERSION;
  readonly artifacts: Readonly<Partial<Record<Store, ArtifactRecord>>>;
}

export function artifactRegisterPath(repoRoot: string): string {
  return join(stateDir(repoRoot), 'artifacts.json');
}

/** SHA-256 of a file, streamed so a 200 MB bundle never lands in memory. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', () => {
      resolvePromise();
    });
  });
  return hash.digest('hex');
}

/** Reads the register, returning an empty one when the project has never built anything. */
export async function readArtifacts(repoRoot: string): Promise<ArtifactRegister> {
  const empty: ArtifactRegister = { schemaVersion: ARTIFACT_REGISTER_VERSION, artifacts: {} };
  let raw: string;
  try {
    raw = await readFile(artifactRegisterPath(repoRoot), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw AgentshipError.from(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `Could not read ${artifactRegisterPath(repoRoot)}.`,
      cause,
    );
  }
  try {
    const parsed = JSON.parse(raw) as ArtifactRegister;
    // A register from another schema is a cache of local files: ignoring it costs a rebuild.
    return parsed.schemaVersion === ARTIFACT_REGISTER_VERSION ? parsed : empty;
  } catch {
    return empty;
  }
}

/** Records (or replaces) the artifact known for one store. */
export async function recordArtifact(
  repoRoot: string,
  record: ArtifactRecord,
): Promise<ArtifactRegister> {
  const current = await readArtifacts(repoRoot);
  const next: ArtifactRegister = {
    schemaVersion: ARTIFACT_REGISTER_VERSION,
    artifacts: { ...current.artifacts, [record.store]: record },
  };
  await ensureDir(stateDir(repoRoot));
  await writeFile(artifactRegisterPath(repoRoot), `${JSON.stringify(next, null, 2)}\n`, {
    mode: FILE_MODE,
  });
  return next;
}

/** Why a recorded artifact can no longer be used. */
export type ArtifactInvalidation = 'missing' | 'size_changed' | 'hash_changed';

export interface ArtifactCheck {
  readonly record: ArtifactRecord;
  readonly valid: boolean;
  readonly reason?: ArtifactInvalidation;
  readonly detail?: string;
}

/**
 * Re-verifies a recorded artifact against the file it points at.
 *
 * The size is checked first because it rules out the common cases (deleted, rebuilt,
 * truncated) without hashing hundreds of megabytes; only a file of exactly the right size
 * is worth hashing.
 */
export async function checkArtifact(record: ArtifactRecord): Promise<ArtifactCheck> {
  let size: number;
  try {
    size = (await stat(record.path)).size;
  } catch {
    return {
      record,
      valid: false,
      reason: 'missing',
      detail: `${record.path} no longer exists.`,
    };
  }
  if (size !== record.sizeBytes) {
    return {
      record,
      valid: false,
      reason: 'size_changed',
      detail: `${record.path} is ${size} bytes, but ${record.sizeBytes} were recorded.`,
    };
  }
  const sha256 = await fileSha256(record.path);
  if (sha256 !== record.sha256) {
    return {
      record,
      valid: false,
      reason: 'hash_changed',
      detail: `${record.path} no longer matches the recorded SHA-256.`,
    };
  }
  return { record, valid: true };
}

/**
 * The artifact a store can publish right now: recorded, still on disk, still the same
 * bytes, and declaring the version and build number the release asks for.
 *
 * Returns `undefined` for every other case, which is precisely what makes a `build` action
 * appear in the plan — and disappear from it once the build has happened.
 *
 * Pass `inputsDigest` to also require that the project has not changed since the build.
 * Callers that decide *whether to build* must pass it — the artifact's own hash cannot see
 * an edited icon. Callers that only need to know where the binary will be (the upload
 * differs, whose path is deterministic either way) do not.
 */
export async function usableArtifact(
  repoRoot: string,
  store: Store,
  wanted: {
    readonly version?: string;
    readonly buildNumber?: string;
    readonly inputsDigest?: string;
  } = {},
): Promise<ArtifactRecord | undefined> {
  const record = (await readArtifacts(repoRoot)).artifacts[store];
  if (record === undefined) return undefined;
  if (wanted.version !== undefined && record.version !== wanted.version) return undefined;
  if (wanted.buildNumber !== undefined && record.buildNumber !== wanted.buildNumber) {
    return undefined;
  }
  // An absent digest on either side is "unknown", never "unchanged": a record from before
  // the project was fingerprinted, or a tree that could not be read, both mean rebuild.
  if (wanted.inputsDigest !== undefined && record.inputsDigest !== wanted.inputsDigest) {
    return undefined;
  }
  const check = await checkArtifact(record);
  return check.valid ? record : undefined;
}

/** Resolves a manifest-relative artifact path against the repository root. */
export function resolveArtifactPath(repoRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

/** Where builds put their output: inside the project's Agentship directory, never in git. */
export function buildOutputDir(repoRoot: string, store: Store): string {
  return join(resolve(repoRoot), '.agentship', 'build', store);
}

/**
 * The path a build *will* write, derived only from the release.
 *
 * Deterministic on purpose. The upload action has to be planned before the build has run,
 * and a plan cannot reference a filename that does not exist yet — so the filename is a
 * function of (store, version, build number, kind) rather than of whatever Xcode or Gradle
 * happened to name the file. That is what lets `build` and `upload_build` be two ordinary
 * actions in one plan, chained by a dependency, instead of one opaque step.
 */
export function plannedArtifactPath(
  repoRoot: string,
  store: Store,
  kind: ArtifactKind,
  version: string,
  buildNumber: string,
): string {
  const safe = `${version}-${buildNumber}`.replace(/[^A-Za-z0-9._-]/g, '-');
  return join(buildOutputDir(repoRoot, store), `${store}-${safe}.${kind}`);
}
