import { stat } from 'node:fs/promises';
import {
  AgentshipError,
  type ArtifactKind,
  type ArtifactRecord,
  ERROR_CODES,
  fileSha256,
  isBinaryPlist,
  parseBinaryPlist,
  type Store,
} from '@agentship/core';
import plist from 'plist';
import { listZipEntries, readZipFile } from './zip.js';

/**
 * Verifying what a build actually produced.
 *
 * A build tool that exits zero has not proved anything: the wrong scheme archives happily,
 * a stale `agvtool` setting produces yesterday's build number, and an export can succeed
 * with an artifact nobody wants. So the artifact is opened and read back, and what it says
 * about itself is compared with what the release asked for.
 *
 * The two platforms allow very different depths here, and the difference is reported rather
 * than smoothed over:
 *
 * - **iOS** — `Info.plist` inside the `.app` is a real, parseable manifest, so bundle id,
 *   marketing version and build number are all *verified*.
 * - **Android** — an `.aab`'s manifest is compiled Android binary XML and its metadata is
 *   protobuf. Agentship checks the archive is structurally an app bundle and stops there;
 *   version and versionCode are recorded as *requested*, and listed in
 *   {@link ArtifactRecord.unverified} so nothing downstream mistakes them for facts.
 */
export interface ArtifactExpectation {
  readonly store: Store;
  readonly kind: ArtifactKind;
  readonly version: string;
  readonly buildNumber: string;
  readonly bundleId?: string;
  readonly builder: string;
  readonly logPath?: string;
  /** Fingerprint of the source tree, taken before the build; absent when it could not be. */
  readonly inputsDigest?: string;
}

export interface ArtifactInspection {
  readonly bundleId?: string;
  readonly version?: string;
  readonly buildNumber?: string;
  /** Fields the archive format does not let Agentship confirm. */
  readonly unverified: readonly string[];
}

/** Reads back what an `.ipa` says about itself. */
export async function inspectIpa(path: string): Promise<ArtifactInspection> {
  const found = await readZipFile(path, (name) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name));
  if (found === undefined) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `${path} contains no Payload/<App>.app/Info.plist, so it is not an iOS application archive.`,
      { details: { path } },
    );
  }
  let parsed: Record<string, unknown>;
  try {
    // Xcode packages the Info.plist as a *binary* plist, which the `plist` package does not
    // read — and decoding those bytes as UTF-8 first destroys them. So the format is decided
    // by the header: binary goes to Agentship's own reader, XML (what a hand-built or
    // re-signed archive can carry) to the library.
    parsed = (
      isBinaryPlist(found.contents)
        ? parseBinaryPlist(found.contents)
        : plist.parse(found.contents.toString('utf8'))
    ) as Record<string, unknown>;
  } catch (cause) {
    throw AgentshipError.from(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `${path} has an Info.plist Agentship could not parse.`,
      cause,
      { details: { path, entry: found.name } },
    );
  }
  const read = (key: string): string | undefined => {
    const value = parsed[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const bundleId = read('CFBundleIdentifier');
  const version = read('CFBundleShortVersionString');
  const buildNumber = read('CFBundleVersion');
  return {
    ...(bundleId === undefined ? {} : { bundleId }),
    ...(version === undefined ? {} : { version }),
    ...(buildNumber === undefined ? {} : { buildNumber }),
    unverified: [],
  };
}

/**
 * Confirms an `.aab` is structurally an app bundle.
 *
 * Deliberately shallow, and documented as such: reading the version out of an app bundle
 * means decoding `BundleConfig.pb` and Android binary XML, and a half-correct decoder that
 * silently returns the wrong versionCode would be worse than an honest "not verified".
 */
export async function inspectAab(path: string): Promise<ArtifactInspection> {
  const entries = await listZipEntries(path);
  const names = new Set(entries.map((entry) => entry.name));
  const missing = ['BundleConfig.pb', 'base/manifest/AndroidManifest.xml'].filter(
    (required) => !names.has(required),
  );
  if (missing.length > 0) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `${path} is missing ${missing.join(' and ')}, so it is not an Android App Bundle.`,
      { details: { path, missing } },
    );
  }
  return {
    unverified: [
      'version and versionCode: an app bundle stores them as compiled protobuf/binary XML, which Agentship does not decode. Play validates them at upload.',
    ],
  };
}

/** Confirms an `.apk` is structurally an APK. Same honesty as {@link inspectAab}. */
export async function inspectApk(path: string): Promise<ArtifactInspection> {
  const entries = await listZipEntries(path);
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('AndroidManifest.xml')) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `${path} has no AndroidManifest.xml, so it is not an APK.`,
      { details: { path } },
    );
  }
  return {
    unverified: [
      'version and versionCode: an APK stores them as Android binary XML, which Agentship does not decode.',
    ],
  };
}

async function inspect(path: string, kind: ArtifactKind): Promise<ArtifactInspection> {
  switch (kind) {
    case 'ipa':
    case 'pkg':
      return inspectIpa(path);
    case 'aab':
      return inspectAab(path);
    case 'apk':
      return inspectApk(path);
  }
}

/**
 * Verifies and records a freshly built artifact.
 *
 * A version or build number the artifact contradicts is a hard failure. It means the build
 * did not honour the injection — a project that hard-codes its version, an unexpected
 * flavour — and uploading it would publish something other than what was planned, which is
 * the exact class of surprise the whole engine exists to prevent.
 */
export async function verifyArtifact(
  path: string,
  expectation: ArtifactExpectation,
): Promise<ArtifactRecord> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `The build reported success but produced no file at ${path}.`,
      { details: { path } },
    );
  }
  if (info.size === 0) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `The build produced an empty file at ${path}.`,
      { details: { path } },
    );
  }

  const inspection = await inspect(path, expectation.kind);
  const mismatches: string[] = [];
  if (inspection.version !== undefined && inspection.version !== expectation.version) {
    mismatches.push(
      `marketing version: the artifact declares ${inspection.version}, the release asks for ${expectation.version}`,
    );
  }
  if (inspection.buildNumber !== undefined && inspection.buildNumber !== expectation.buildNumber) {
    mismatches.push(
      `build number: the artifact declares ${inspection.buildNumber}, the release asks for ${expectation.buildNumber}`,
    );
  }
  if (
    expectation.bundleId !== undefined &&
    inspection.bundleId !== undefined &&
    inspection.bundleId !== expectation.bundleId
  ) {
    mismatches.push(
      `bundle identifier: the artifact declares ${inspection.bundleId}, the manifest declares ${expectation.bundleId}`,
    );
  }
  if (mismatches.length > 0) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_ARTIFACT_INVALID,
      `The artifact does not match the release — ${mismatches.join('; ')}.`,
      {
        retryable: false,
        details: { path, mismatches },
        remediation: {
          summary:
            'The project sets these values itself. Either align the manifest with the project, or remove the hard-coded values from the project so Agentship can inject them.',
        },
      },
    );
  }

  return {
    store: expectation.store,
    path,
    kind: expectation.kind,
    sha256: await fileSha256(path),
    sizeBytes: info.size,
    version: inspection.version ?? expectation.version,
    buildNumber: inspection.buildNumber ?? expectation.buildNumber,
    ...(inspection.bundleId === undefined
      ? expectation.bundleId === undefined
        ? {}
        : { bundleId: expectation.bundleId }
      : { bundleId: inspection.bundleId }),
    builder: expectation.builder,
    ...(expectation.inputsDigest === undefined ? {} : { inputsDigest: expectation.inputsDigest }),
    builtAt: new Date().toISOString(),
    ...(expectation.logPath === undefined ? {} : { logPath: expectation.logPath }),
    ...(inspection.unverified.length === 0 ? {} : { unverified: inspection.unverified }),
  };
}
