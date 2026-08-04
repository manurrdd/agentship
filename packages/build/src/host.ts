import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  AgentshipError,
  ERROR_CODES,
  type Logger,
  type RunResult,
  runToolRaw,
} from '@agentship/core';

/**
 * Running the host's build tools.
 *
 * These are not managed binaries: Xcode, a JDK and the Flutter SDK belong to the user's
 * machine and Agentship neither installs nor pins them. What Agentship does control is how they
 * are invoked, and it is the same discipline the store backends get — an absolute path
 * (never a `PATH` lookup at exec time), an explicit environment instead of an inherited
 * one, a wall-clock budget, and no secret in argv.
 *
 * The environment matters more here than anywhere else in Agentship. A build runs the user's
 * own code — Gradle plugins, CocoaPods scripts, Xcode run-script phases — so the child must
 * not inherit whatever credentials happen to be configured in this process. Every `AGENTSHIP_*`
 * variable is therefore stripped, and only the small allow-list a build genuinely needs is
 * forwarded. Android signing goes further: the child gets only the app-scoped upload keystore
 * password, through a 0600 init-script file, never the environment.
 *
 * The one credential that does cross this boundary is the App Store Connect API key, and only
 * on iOS: `xcodebuild`/`flutter build ipa` perform automatic signing during *archive*, which
 * is a step that runs the repository's build phases, and Apple offers no way to sign without
 * handing that step the account key (see `flutter.ts`/`ios.ts`). That is a known residual
 * exposure — a hostile repository's build scripts could read the 0600 `.p8` — documented in
 * `docs/security-audit-v1.md`. Nothing weaker than a signing rework (manual profiles for the
 * archive, ASC creds only at export) closes it, so the boundary is stated here, not implied.
 */

/** Variables a build tool needs that the shared runner does not forward by default. */
const BUILD_ENV_KEYS: readonly string[] = [
  'DEVELOPER_DIR',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'GRADLE_USER_HOME',
  'GRADLE_OPTS',
  'FLUTTER_ROOT',
  'PUB_CACHE',
  'CI',
  'LC_CTYPE',
  'SHELL',
  'USER',
  'LOGNAME',
];

/**
 * The environment a build child gets: the host's build variables, minus everything Agentship.
 *
 * Compiling executes code the repository author wrote. That is a trust boundary Agentship
 * accepts — there is no way to build an app without running its build scripts — so this strips
 * Agentship's own configuration and forwards only build variables. It does not, on its own, add
 * store credentials; the iOS archive path adds the App Store Connect key explicitly (and
 * unavoidably) for automatic signing, which is the documented exception noted in the module
 * header.
 */
export function buildEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BUILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith('AGENTSHIP_')) {
      throw new AgentshipError(
        ERROR_CODES.BUILD_FAILED,
        `Refusing to put ${key} in a build environment: build scripts must never see Agentship's own configuration.`,
      );
    }
    env[key] = value;
  }
  return env;
}

/** Resolves an executable to an absolute path, following `PATH` exactly once, up front. */
export async function findHostTool(name: string): Promise<string | undefined> {
  if (name.includes('/')) {
    const absolute = resolve(name);
    return (await isExecutable(absolute)) ? absolute : undefined;
  }
  const path = process.env['PATH'] ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface HostToolSpec {
  /** Executable name or absolute path. */
  readonly name: string;
  /** What the user installs to get it, for the error when it is absent. */
  readonly install: string;
}

/** Resolves a host tool or fails with an error the agent can act on. */
export async function requireHostTool(spec: HostToolSpec): Promise<string> {
  const path = await findHostTool(spec.name);
  if (path === undefined) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_TOOL_MISSING,
      `${spec.name} is not installed on this machine, or is not on PATH.`,
      {
        details: { tool: spec.name },
        remediation: { summary: spec.install },
      },
    );
  }
  return path;
}

export interface HostRunOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly cancelSignal?: AbortSignal;
  readonly logger?: Logger;
  readonly toolName?: string;
  /** Written to the child's stdin — the only safe channel for a password. */
  readonly stdin?: string;
}

/** Default budget for one build tool invocation: builds are slow, but not unbounded. */
export const DEFAULT_BUILD_TIMEOUT_MS = 45 * 60_000;

/**
 * Runs a host build tool and returns its result whatever the exit code.
 *
 * Classification is the caller's job — only a builder knows what a given exit code means
 * for its tool — so a failure comes back as data, exactly as it does for the store
 * backends.
 */
export async function runHostTool(executable: string, options: HostRunOptions): Promise<RunResult> {
  if (!isAbsolute(executable)) {
    throw new AgentshipError(
      ERROR_CODES.BUILD_FAILED,
      `Refusing to run "${executable}": build tools are resolved to an absolute path first.`,
    );
  }
  return runToolRaw(executable, {
    args: options.args,
    cwd: options.cwd,
    env: buildEnv(options.env ?? {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    // A build is expensive and rarely fails transiently; a blind retry mostly burns minutes.
    retry: false,
    toolName: options.toolName ?? executable.split('/').pop() ?? executable,
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
  });
}
