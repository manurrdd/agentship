import type { ArtifactKind, ArtifactRecord, Store } from '@agentship/core';

/**
 * The vocabulary of a build.
 *
 * A build is the one step of publishing that runs the user's own code on the user's own
 * machine. Everything here is written around that fact: what Agentship will run is decided in
 * advance and reported (`BuildCommand`), what it produced is verified against the artifact
 * itself rather than trusted (`ArtifactRecord`), and what it could not verify is listed
 * instead of assumed.
 */

/** The builders Agentship implements, one per (framework, platform) pair it supports. */
export type BuilderId = 'ios-xcodebuild' | 'android-gradle' | 'flutter-ios' | 'flutter-android';

export const BUILDER_IDS: readonly BuilderId[] = [
  'ios-xcodebuild',
  'android-gradle',
  'flutter-ios',
  'flutter-android',
];

export type BuildPlatform = 'ios' | 'android';

/** Store a platform's artifact is destined for. */
export function storeForPlatform(platform: BuildPlatform): Store {
  return platform === 'ios' ? 'apple' : 'google';
}

/** What a builder will run, decided before anything is executed so it can be shown first. */
export interface BuildCommand {
  /** Absolute path of the executable. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** One line an agent can print, with no absolute paths or secrets. */
  readonly summary: string;
}

/** Everything a build needs, resolved from the manifest and the repository. */
export interface BuildRequest {
  readonly repoRoot: string;
  readonly platform: BuildPlatform;
  readonly version: string;
  readonly buildNumber: string;
  /** Credential profile whose Apple key signs the iOS build. */
  readonly profile: string;
  /** Where to write the artifact; defaults to `.agentship/build/<platform>/`. */
  readonly outputDir?: string;
  readonly cancelSignal?: AbortSignal;
  /** Wall-clock budget. Archiving a large app routinely takes ten minutes or more. */
  readonly timeoutMs?: number;
}

/** How a builder answers "can you build this here, and with what?". */
export type BuildSupportStatus =
  /** Agentship can build it on this machine. */
  | 'supported'
  /** Agentship implements it, but this host cannot (an .ipa outside macOS). */
  | 'host_unsupported'
  /** Agentship implements it, but a tool is missing. */
  | 'tool_missing'
  /** A value is missing from the manifest (a scheme, a keystore alias). */
  | 'needs_input'
  /** Agentship deliberately does not build this shape of project. */
  | 'unsupported';

export interface BuildSupport {
  readonly builder: BuilderId;
  readonly platform: BuildPlatform;
  readonly status: BuildSupportStatus;
  /** One sentence explaining the status, written for an agent to relay. */
  readonly detail: string;
  /** Manifest paths the user must fill in, when the status is `needs_input`. */
  readonly needsInput?: readonly string[];
  /** What the user has to do; absent when the status is `supported`. */
  readonly remediation?: string;
}

export interface BuildOutcome {
  readonly artifact: ArtifactRecord;
  /** Commands that ran, in order, for the transcript an agent shows the user. */
  readonly commands: readonly string[];
  /** Full build log; never inlined into a tool response. */
  readonly logPath: string;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}

/** Where an artifact of a given kind lands by default. */
export function defaultArtifactName(
  appName: string,
  version: string,
  buildNumber: string,
  kind: ArtifactKind,
): string {
  const safe = appName.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${safe}-${version}-${buildNumber}.${kind}`;
}
